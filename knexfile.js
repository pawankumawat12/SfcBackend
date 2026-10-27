require("dotenv").config();

const isLocalhost =
  process.env.DB_HOST === "127.0.0.1" || process.env.DB_HOST === "localhost";
const sslConfig =
  process.env.DB_SSL === "true" || (!isLocalhost && Boolean(process.env.DB_HOST))
    ? { rejectUnauthorized: false }
    : false;

const dbConnection = {
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: sslConfig,
};

module.exports = {
  development: {
    client: "pg",
    connection: dbConnection,
    pool: {
      min: 2,
      max: 10,
    },
    migrations: {
      directory: "./migrations",
      tableName: "knex_migrations",
    },
  },

  staging: {
    client: "pg",
    connection: dbConnection,
    pool: {
      min: 2,
      max: 10,
    },
    migrations: {
      directory: "./migrations",
      tableName: "knex_migrations",
    },
  },

  production: {
    client: "pg",
    connection: dbConnection,
    pool: {
      min: 2,
      max: 10,
    },
    migrations: {
      directory: "./migrations",
      tableName: "knex_migrations",
    },
    seeds: {
      directory: "./seeds",
    },
  },
};

