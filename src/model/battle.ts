import { selectAction } from "../ai/select-action.js";
import { buildPokemon } from "../data/pokemon-data.js";
import { logDebug, logInfo, logNewEvents } from "../util/logger.js";
import { Random } from "../util/random.js";
import { BattleEvent, PlayerActionEvent, SelectPokemonDetails } from "./battle-event.js";
import { BattleRound, BattleRounds } from "./battle-round.js";
import { getActivePokemonForPlayer, Player } from "./player.js";
import { isAlive } from "./pokemon.js";
import { Weather, weatherDescriptions } from "./weather.js";

export type BattleState = 
  'SELECTING_TEAM' | 
  'SELECTING_FIRST_POKEMON' | 
  'SELECTING_ACTIONS' | 
  'SELECTING_REQUIRED_SWITCH' | 
  'GAME_OVER' | 
  'GAME_OVER_AND_REMATCH_REQUESTED';

export type BattleType = 'SINGLE_PLAYER' | 'MULTI_PLAYER';
export type BattleSubType = 'ARENA' | 'LEAGUE' | 'PRACTICE' | 'CHALLENGE';

export interface BattleData {
  battleState?: BattleState;
  battleId?: string;
  battleType: BattleType;
  battleSubType: BattleSubType;
  leagueLevel?: number;
  players: Player[];
  events?: BattleEvent[];
  pendingPlayerAction?: PlayerActionEvent | null | undefined;
  requiredToSwitch?: string[];
  rematchRequested?: boolean;
  weather: Weather;
  remainingWeatherTurns: number;
  winnerName?: string;
  rewards: number[];
  turnCount: number;
}

export class Battle {
  battleRounds: BattleRounds = new BattleRounds();
  random: Random = new Random();

  battleState: BattleState;
  battleId: string;
  battleType: BattleType;
  battleSubType: BattleSubType;
  leagueLevel?: number;
  players: Player[];
  events: BattleEvent[];
  pendingPlayerAction: PlayerActionEvent | null | undefined;
  requiredToSwitch: string[];
  rematchRequested?: boolean;
  weather: Weather;
  remainingWeatherTurns: number;
  winnerName?: string;
  rewards: number[];
  turnCount: number;

  private playerTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly INACTIVITY_TIMEOUT = 100000; // 100 seconds

  constructor(battleData: BattleData) {
    this.battleType = battleData.battleType || 'MULTI_PLAYER';
    this.battleSubType = battleData.battleSubType || 'CHALLENGE';
    this.leagueLevel = battleData.leagueLevel;
    this.battleState = battleData.battleState || 'SELECTING_TEAM';
    this.battleId = battleData.battleId || this.random.generateId();
    this.players = battleData.players || [];
    this.events = battleData.events || [];
    this.pendingPlayerAction = battleData.pendingPlayerAction;
    this.requiredToSwitch = battleData.requiredToSwitch || [];
    this.rematchRequested = battleData.rematchRequested;
    this.weather = battleData.weather;
    this.remainingWeatherTurns = battleData.remainingWeatherTurns;
    this.rewards = battleData.rewards;
    this.winnerName = battleData.winnerName;
    this.turnCount = battleData.turnCount;
  }

  getData(): BattleData {
    return {
      battleState: this.battleState,
      battleId: this.battleId,
      battleType: this.battleType,
      battleSubType: this.battleSubType,
      leagueLevel: this.leagueLevel,
      players: this.players,
      events: this.events,
      pendingPlayerAction: this.pendingPlayerAction,
      requiredToSwitch: this.requiredToSwitch,
      rematchRequested: this.rematchRequested,
      weather: this.weather,
      remainingWeatherTurns: this.remainingWeatherTurns,
      rewards: this.rewards,
      winnerName: this.winnerName,
      turnCount: this.turnCount,
    };
  }

  getPlayer(name: string): Player {
    const player = this.players.find(player => player.name === name);
    if (player) {
      return player;
    } else {
      throw new Error(`No player named ${name} in battleId ${this.battleId}`);
    }
  }

  getOtherPlayer(player: Player): Player {
    return player === this.players[0] ? this.players[1] : this.players[0];
  }

  getComputerPlayer(): Player {
    const player = this.players.find(player => player.type === 'COMPUTER')
    if (player) {
      return player
    } else {
      throw new Error(`No computer player in battleId ${this.battleId}`)
    }
  }
  startInactivityTimer(playerName: string) {
    if (this.playerTimers.has(playerName)) {
      clearTimeout(this.playerTimers.get(playerName)!);
    }

    const timer = setTimeout(() => {
      this.handleInactivePlayer(playerName);
    }, this.INACTIVITY_TIMEOUT);

    this.playerTimers.set(playerName, timer);
  }

  handleInactivePlayer(playerName: string) {
    if (this.battleSubType !== 'CHALLENGE' && this.battleType !== 'MULTI_PLAYER') return;

    logInfo(`${playerName} has been inactive for 100 seconds. They lose the match.`);
    this.battleState = 'GAME_OVER';
    this.winnerName = this.getOtherPlayer(this.getPlayer(playerName)).name;

    this.events.push({
      type: 'DISPLAY_MESSAGE',
      message: `${playerName} was inactive for too long and lost the match.`,
    });

    this.clearAllTimers();
  }

  clearAllTimers() {
    this.playerTimers.forEach((timer) => clearTimeout(timer));
    this.playerTimers.clear();
  }

  receivePlayerAction(playerAction: PlayerActionEvent) {
    logInfo(`Received player action from ${playerAction.playerName}: ${playerAction.details.type}`);

    this.startInactivityTimer(playerAction.playerName); // Reset timer for the active player
    this.validatePlayerAction(playerAction);

    if (this.battleState === 'GAME_OVER') {
      this.clearAllTimers();
      return;
    }

    if (this.pendingPlayerAction) {
      const otherPlayerAction = this.pendingPlayerAction;
      this.pendingPlayerAction = null;
      this.doActions([otherPlayerAction, playerAction]);
    } else {
      this.pendingPlayerAction = playerAction;
    }
  }

  validatePlayerAction(playerAction: PlayerActionEvent) {
    if (this.pendingPlayerAction && this.pendingPlayerAction.playerName === playerAction.playerName) {
      throw new Error(`${playerAction.playerName} already submitted their action`);
    }
    if (!this.players.find(player => player.name === playerAction.playerName)) {
      throw new Error('Invalid playerName: ' + playerAction.playerName);
    }
    if (this.battleState === 'GAME_OVER' && playerAction.details.type !== 'REQUEST_REMATCH') {
      throw new Error('Battle has already ended');
    }
  }

  doActions(playerActions: PlayerActionEvent[]) {
    const previousEventsSize = this.events.length;
    const battleRound = this.battleRounds.new(this, playerActions);
    battleRound.start();
    const newEvents = this.events.slice(previousEventsSize, this.events.length);
    logNewEvents('Finished doing actions. New events:');
    logNewEvents(newEvents);
  }

  applyWeather(newWeather: Weather) {
    this.events.push({
      type: 'DISPLAY_MESSAGE',
      message: `The weather changed to ${weatherDescriptions[newWeather]}!`
    });
    this.events.push({
      type: 'WEATHER_CHANGE',
      newWeather: newWeather
    });
    this.weather = newWeather;
    this.remainingWeatherTurns = 5;
  }

  pushHazardsChangeEvent(player: Player) {
    this.events.push({
      type: 'HAZARDS_CHANGE',
      playerName: player.name,
      spikeLayerCount: player.spikeLayerCount,
      toxicSpikeLayerCount: player.toxicSpikeLayerCount,
      hasStealthRock: player.hasStealthRock,
      hasStickyWeb: player.hasStickyWeb,
      hasLightScreen: player.remainingLightScreenTurns > 0,
      hasReflect: player.remainingReflectTurns > 0
    });
  }
        }
