const express = require("express");
const { Pool } = require("pg");
const { engine } = require("express-handlebars");
require("dotenv").config();

const app = express();
const port = 3000;
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DB });

app.engine("hbs", engine({
  extname: ".hbs",
  helpers: {
    eq: (a, b) => a === b,
    add: (a, b) => Number(a) + Number(b),
    sub: (a, b) => Number(a) - Number(b),
  },
}));
app.set("view engine", "hbs");

async function ensureIdColumn(tableName) {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'id'`,
    [tableName],
  );
  if (!rows.length) {
    await pool.query(
      `ALTER TABLE "${tableName}" ADD COLUMN id SERIAL PRIMARY KEY`,
    );
  }
}

async function tableExists(tableName) {
  const { rows } = await pool.query(
    `SELECT 1 FROM pg_stat_user_tables
     WHERE schemaname = 'public' AND relname = $1`,
    [tableName],
  );
  return rows.length > 0;
}

async function getColumns(tableName) {
  const { rows } = await pool.query(
    `SELECT column_name, data_type
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [tableName],
  );
  return rows;
}

async function getAllTables() {
  const { rows } = await pool.query(
    `SELECT relname AS name, n_live_tup AS count
     FROM pg_stat_user_tables
     WHERE schemaname = 'public'
     ORDER BY relname`,
  );
  return rows;
}

async function getRowById(tableName, id) {
  const { rows } = await pool.query(
    `SELECT * FROM "${tableName}" WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

async function getTableData(tableName, page = 1, limit = 25, search = "") {
  await ensureIdColumn(tableName);
  const columns = await getColumns(tableName);
  const offset = (page - 1) * limit;
  const colNames = columns.map((c) => c.column_name);

  let whereClause = "",
    params = [];
  if (search) {
    const conditions = colNames.map(
      (col, i) => `"${col}"::text ILIKE $${i + 1}`,
    );
    whereClause = `WHERE ${conditions.join(" OR ")}`;
    params = colNames.map(() => `%${search}%`);
  }

  const countRes = await pool.query(
    `SELECT COUNT(*) as total FROM "${tableName}" ${whereClause}`,
    params,
  );
  const totalRows = parseInt(countRes.rows[0].total, 10);
  const totalPages = Math.ceil(totalRows / limit) || 1;

  const dataRes = await pool.query(
    `SELECT * FROM "${tableName}" ${whereClause} ORDER BY id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );

  return {
    tableName,
    columns,
    rows: dataRes.rows,
    currentPage: Math.max(1, page),
    totalPages,
    totalRows,
    limit,
    searchTerm: search,
    hasPrev: page > 1,
    hasNext: page < totalPages,
    startRow: totalRows === 0 ? 0 : offset + 1,
    endRow: Math.min(offset + limit, totalRows),
  };
}

async function createTable(tableName, columns) {
  const colDefs = columns
    .filter((c) => c?.name && c?.type)
    .map((c) => `"${c.name}" ${c.type}`)
    .join(", ");
  await pool.query(
    `CREATE TABLE IF NOT EXISTS "${tableName}" (id SERIAL PRIMARY KEY, ${colDefs})`,
  );
}

async function dropTable(tableName) {
  await pool.query(`DROP TABLE IF EXISTS "${tableName}" CASCADE`);
}

async function insertRow(tableName, data) {
  const keys = Object.keys(data).filter(Boolean);
  const values = keys.map((k) => data[k]);
  const result = await pool.query(
    `INSERT INTO "${tableName}"
       (${keys.map((k) => `"${k}"`).join(", ")})
     VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})
     RETURNING *`,
    values,
  );
  return result.rows[0];
}

async function updateRow(tableName, id, data) {
  const keys = Object.keys(data).filter((k) => k !== "id");
  const values = keys.map((k) => data[k]);
  const setClause = keys.map((k, i) => `"${k}" = $${i + 1}`).join(", ");
  const result = await pool.query(
    `UPDATE "${tableName}"
     SET ${setClause}
     WHERE id = $${keys.length + 1}
     RETURNING *`,
    [...values, id],
  );
  return result.rows[0] ?? null;
}

async function deleteRow(tableName, id) {
  const result = await pool.query(
    `DELETE FROM "${tableName}" WHERE id = $1 RETURNING id`,
    [id],
  );
  return result.rowCount > 0;
}

app.get("/", async (req, res, next) => {
  try {
    const tables = await getAllTables();
    res.render("index", { tables });
  } catch (err) {
    next(err);
  }
});

app.post("/tables", async (req, res, next) => {
  const { tableName, columns = [] } = req.body;
  if (!tableName || !Array.isArray(columns) || columns.length === 0) {
    return res.status(400).json({ error: "Missing table name or columns" });
  }
  const validColumns = columns.filter((c) => c?.name && c?.type);
  if (!validColumns.length) {
    return res.status(400).json({ error: "Invalid columns" });
  }
  try {
    await createTable(tableName, validColumns);
    res.status(201).json({ message: `Table "${tableName}" created` });
  } catch (err) {
    next(err);
  }
});

app.delete("/tables/:name", async (req, res, next) => {
  try {
    await dropTable(req.params.name);
    res.status(200).json({ message: `Table "${req.params.name}" deleted` });
  } catch (err) {
    next(err);
  }
});

app.get("/table/:name", async (req, res, next) => {
  try {
    if (!(await tableExists(req.params.name))) {
      return res.status(404).send(`Table "${req.params.name}" not found`);
    }
    const VALID_LIMITS = [10, 25, 50, 100];
    const limit = VALID_LIMITS.includes(parseInt(req.query.limit))
      ? parseInt(req.query.limit)
      : 25;
    const data = await getTableData(
      req.params.name,
      parseInt(req.query.page) || 1,
      limit,
      req.query.q || "",
    );
    res.render("table", data);
  } catch (err) {
    next(err);
  }
});

app.post("/table/:name/rows", async (req, res, next) => {
  const { name: tableName } = req.params;
  const keys = Object.keys(req.body).filter(Boolean);
  if (keys.length === 0) {
    return res.status(400).json({ error: "No data provided" });
  }
  try {
    const row = await insertRow(tableName, req.body);
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

app.get("/table/:name/rows/:id", async (req, res, next) => {
  const { name: tableName, id } = req.params;
  try {
    if (!(await tableExists(tableName))) {
      return res.status(404).json({ error: `Table "${tableName}" not found` });
    }
    const [columns, row] = await Promise.all([
      getColumns(tableName),
      getRowById(tableName, id),
    ]);
    if (!row) {
      return res.status(404).json({ error: "Row not found" });
    }
    if (req.accepts("json") && !req.accepts("html")) {
      return res.json(row);
    }
    res.render("edit", { tableName, id, columns, row });
  } catch (err) {
    next(err);
  }
});

app.put("/table/:name/rows/:id", async (req, res, next) => {
  const { name: tableName, id } = req.params;
  const keys = Object.keys(req.body).filter((k) => k !== "id");
  if (keys.length === 0) {
    return res.status(400).json({ error: "No data to update" });
  }
  try {
    const row = await updateRow(tableName, id, req.body);
    if (!row) {
      return res.status(404).json({ error: "Row not found" });
    }
    res.json(row);
  } catch (err) {
    next(err);
  }
});

app.delete("/table/:name/rows/:id", async (req, res, next) => {
  const { name: tableName, id } = req.params;
  try {
    const deleted = await deleteRow(tableName, id);
    if (!deleted) {
      return res.status(404).json({ error: "Row not found" });
    }
    res.status(200).json({ deleted: id });
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

pool
  .connect()
  .then(() => console.log("DB connected"))
  .catch((err) => console.error("DB failed", err));

app.listen(port, () => console.log(`Server on http://localhost:${port}`));