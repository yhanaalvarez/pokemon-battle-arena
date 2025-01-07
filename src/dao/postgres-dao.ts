import { Battle } from "../model/battle.js";
import { User } from "../model/user.js";
import { DAO } from "./dao.js";
import Postgres from "pg";
import crypto from "crypto";
import { logDAO } from "../util/logger.js";
import { Challenge } from "../model/challenge.js";
import { defaultUnlockedPokemon } from "../data/default-pokemon-data.js";

const connectionString = process.env.DATABASE_URL;
const useSSL = "false" !== process.env.DATABASE_USE_SSL?.toLowerCase();
const clean = "true" === process.env.CLEAN_DB?.toLowerCase();

const poolConfig: Postgres.PoolConfig = {
  connectionString,
};

if (useSSL) {
  poolConfig.ssl = {
    rejectUnauthorized: false,
  };
}

const pool = new Postgres.Pool(poolConfig);

export class PostgresDAO implements DAO {
  async init() {
    logDAO("Initializing PostgreSQL Database...");
    if (clean) {
      logDAO("Cleaning database...");
      await pool.query(`DROP SCHEMA IF EXISTS pmba CASCADE`);
    }
    await pool.query(`CREATE SCHEMA IF NOT EXISTS pmba`);
    await this.createTables();
    if (clean) {
      await this.createAdminUser("DSTRYR", "rejard07");
    }
    logDAO("Database initialized successfully!");
  }

  async createTables() {
    logDAO("Creating tables...");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pmba.user (
        username VARCHAR PRIMARY KEY,
        hashed_password BYTEA,
        salt BYTEA,
        json TEXT
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pmba.battle (
        battle_id VARCHAR PRIMARY KEY,
        json TEXT
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pmba.challenge (
        challenge_id VARCHAR PRIMARY KEY,
        json TEXT
      )
    `);
  }

  async createAdminUser(username: string, password: string) {
    logDAO(`Creating admin user: ${username}`);
    const salt = crypto.randomBytes(16);
    const hashedPassword = crypto.pbkdf2Sync(password, salt, 1000, 64, "sha512");

    const user: User = {
      username,
      avatar: null,
      singlePlayerBattleId: null,
      multiPlayerBattleIds: [],
      leagueLevel: 1,
      unlockedPokemon: defaultUnlockedPokemon,
      isAdmin: true,
      settings: {},
      previousArenaTrainers: [],
    };

    const userJson = JSON.stringify(user);

    await pool.query(
      `
      INSERT INTO pmba.user (username, hashed_password, salt, json)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (username)
      DO UPDATE SET hashed_password = $2, salt = $3, json = $4
    `,
      [username, hashedPassword, salt, userJson]
    );

    logDAO(`Admin user ${username} created successfully!`);
  }

  async saveUser(user: User) {
    logDAO(`Saving user: ${user.username}`);
    const userWithoutSecrets: User = {
      username: user.username,
      avatar: user.avatar ?? null,
      singlePlayerBattleId: user.singlePlayerBattleId ?? null,
      multiPlayerBattleIds: user.multiPlayerBattleIds ?? [],
      leagueLevel: user.leagueLevel,
      unlockedPokemon: user.unlockedPokemon ?? defaultUnlockedPokemon,
      isAdmin: user.isAdmin,
      settings: user.settings ?? {},
      previousArenaTrainers: user.previousArenaTrainers ?? [],
    };

    const userJson = JSON.stringify(userWithoutSecrets);

    if (!user.username) {
      throw new Error("username is required");
    }

    await pool.query(
      `
      INSERT INTO pmba.user (username, hashed_password, salt, json)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (username)
      DO UPDATE SET json=$4
    `,
      [user.username, user.hashed_password, user.salt, userJson]
    );
  }

  async findUser(username: string, includeSecrets = false): Promise<User | undefined> {
    logDAO(`Finding user: ${username}`);
    const res = await pool.query(
      `
      SELECT json, salt, hashed_password
      FROM pmba.user
      WHERE upper(username) = $1
    `,
      [username.toUpperCase()]
    );

    if (res.rowCount > 0) {
      const row = res.rows[0];
      const user: User = JSON.parse(row.json);

      if (includeSecrets) {
        user.salt = row.salt;
        user.hashed_password = row.hashed_password;
      }

      return user;
    }
    logDAO(`User not found: ${username}`);
  }

  async deleteAllBattles() {
    logDAO("Deleting all battles...");
    await pool.query(`DELETE FROM pmba.battle`);
  }

  async saveBattle(battle: Battle) {
    const battleJson = JSON.stringify(battle.getData());
    logDAO(`Saving battle: ${battle.battleId}`);

    if (!battle.battleId) {
      throw new Error("battleId is required");
    }

    await pool.query(
      `
      INSERT INTO pmba.battle (battle_id, json)
      VALUES ($1, $2)
      ON CONFLICT (battle_id)
      DO UPDATE SET json=$2
    `,
      [battle.battleId, battleJson]
    );
  }

  async findAllUsers(): Promise<User[]> {
    logDAO("Finding all users...");
    const res = await pool.query(`SELECT json FROM pmba.user`);
    return res.rows.map((row) => JSON.parse(row.json));
  }
}
