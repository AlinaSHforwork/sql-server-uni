const express = require("express");
const { Pool } = require("pg");
const { engine } = require("express-handlebars");
require("dotenv").config();

const app = express();
const port = 3000;
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DB });

const hbs = engine({
  extname: ".hbs",
  helpers: {
    eq: (a, b) => a === b,
    add: (a, b) => Number(a) + Number(b),
    sub: (a, b) => Number(a) - Number(b),
  },
});
app.engine("hbs", hbs);
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
      console.log(`Added id to ${tableName}`);
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

async function getTableData(tableName, page = 1, limit = 25, search = "") {
  await ensureIdColumn(tableName);
  const columnsRes = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [tableName],
  );
  const columns = columnsRes.rows;
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

app.get("/", async (req, res) => {
  try {
    const { rows: tables } = await pool.query(
      `SELECT relname as name, n_live_tup as count FROM pg_stat_user_tables
       WHERE schemaname = 'public' ORDER BY relname`,
    );
    res.render("index", { tables });
  } catch (err) {
    console.error("Index error:", err);
    res.render("index", { tables: [] });
  }
});

app.post("/tables", async (req, res) => {
  const { tableName, columns = [] } = req.body;
  if (!tableName || !Array.isArray(columns) || columns.length === 0) {
    return res.status(400).json({ error: "Missing table name or columns" });
  }

  const colDefs = columns
    .filter((c) => c?.name && c?.type)
    .map((c) => `"${c.name}" ${c.type}`)
    .join(", ");

  if (!colDefs) return res.status(400).json({ error: "Invalid columns" });

  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS "${tableName}" (id SERIAL PRIMARY KEY, ${colDefs})`,
    );
    res.status(201).json({ message: `Table "${tableName}" created` });
  } catch (err) {
    console.error("Create table error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/tables/:name", async (req, res) => {
  try {
    await pool.query(`DROP TABLE IF EXISTS "${req.params.name}" CASCADE`);
    res.status(200).json({ message: `Table "${req.params.name}" deleted` });
  } catch (err) {
    console.error("Drop table error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/table/:name", async (req, res) => {
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
    console.error("Table error:", err);
    res.status(500).send("Error loading table");
  }
});

app.post("/table/:name/rows", async (req, res) => {
  const { name: tableName } = req.params;
  const data = req.body;

  const keys = Object.keys(data).filter(Boolean);
  if (keys.length === 0) return res.status(400).json({ error: "No data provided" });

  try {
    const values = keys.map((k) => data[k]);
    const result = await pool.query(
      `INSERT INTO "${tableName}"
         (${keys.map((k) => `"${k}"`).join(", ")})
       VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})
       RETURNING *`,
      values,
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Insert error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/table/:name/rows/:id", async (req, res) => {
  const { name: tableName, id } = req.params;
  try {
    if (!(await tableExists(tableName))) {
      return res.status(404).json({ error: `Table "${tableName}" not found` });
    }

    const columnsRes = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [tableName],
    );

    const rowRes = await pool.query(
      `SELECT * FROM "${tableName}" WHERE id = $1`,
      [id],
    );

    if (!rowRes.rows.length) {
      return res.status(404).json({ error: "Row not found" });
    }

    if (req.accepts("json") && !req.accepts("html")) {
      return res.json(rowRes.rows[0]);
    }

    res.render("edit", {
      tableName,
      id,
      columns: columnsRes.rows,
      row: rowRes.rows[0],
    });
  } catch (err) {
    console.error("Edit error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.put("/table/:name/rows/:id", async (req, res) => {
  const { name: tableName, id } = req.params;
  const data = req.body;

  const keys = Object.keys(data).filter((k) => k !== "id");
  if (keys.length === 0) return res.status(400).json({ error: "No data to update" });

  try {
    const values = keys.map((k) => data[k]);
    const setClause = keys.map((k, i) => `"${k}" = $${i + 1}`).join(", ");

    const result = await pool.query(
      `UPDATE "${tableName}"
       SET ${setClause}
       WHERE id = $${keys.length + 1}
       RETURNING *`,
      [...values, id],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Row not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Update error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/table/:name/rows/:id", async (req, res) => {
  const { name: tableName, id } = req.params;

  try {
    const result = await pool.query(
      `DELETE FROM "${tableName}" WHERE id = $1 RETURNING id`,
      [id],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Row not found" });
    }

    res.status(200).json({ deleted: id });
  } catch (err) {
    console.error("Delete row error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

pool
  .connect()
  .then(() => console.log("DB connected"))
  .catch((err) => console.error("DB failed", err));

app.listen(port, () => console.log(`Server on http://localhost:${port}`));
