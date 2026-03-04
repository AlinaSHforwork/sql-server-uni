const express = require("express");
const app = express();
const port = 3000;
const dotenv = require("dotenv");
const { Pool } = require("pg");
const { engine } = require("express-handlebars");

dotenv.config();

app.use(express.urlencoded({ extended: true }));

const pool = new Pool({
  connectionString: process.env.DB,
});

const hbs = engine({
  extname: ".hbs",
  helpers: {
    eq: (a, b) => a === b,
    lookup: (obj, key) => (obj && obj[key] !== undefined ? obj[key] : ""),
    add: (a, b) => Number(a) + Number(b),
    sub: (a, b) => Number(a) - Number(b),
  },
});
app.engine("hbs", hbs);
app.set("view engine", "hbs");

pool
  .connect()
  .then(() => console.log("Connected to PostgreSQL"))
  .catch((err) => console.error("Database connection failed", err));

app.get("/", async (req, res) => {
  try {
    const tablesResult = await pool.query(`
      SELECT relname as name, n_live_tup as count
      FROM pg_stat_user_tables 
      WHERE schemaname = 'public'
      ORDER BY relname
    `);
    res.render("index", { tables: tablesResult.rows });
  } catch (err) {
    console.error(err);
    res.render("index", { tables: [] });
  }
});

app.post("/create", async (req, res) => {
  const { tableName } = req.body;
  let columns = req.body.columns || [];
  if (!Array.isArray(columns)) columns = Object.values(columns);

  if (!tableName || columns.length === 0) {
    return res.status(400).send("Missing table name or columns");
  }

  try {
    const colDefs = columns
      .filter((c) => c && c.name && c.type)
      .map((c) => `"${c.name}" ${c.type}`)
      .join(", ");

    await pool.query(`CREATE TABLE IF NOT EXISTS "${tableName}" (
      id SERIAL PRIMARY KEY,
      ${colDefs}
    )`);
    res.redirect("/");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error creating table: " + err.message);
  }
});

app.post("/delete", async (req, res) => {
  const { tableName } = req.body;
  try {
    await pool.query(`DROP TABLE IF EXISTS "${tableName}" CASCADE`);
    res.redirect("/");
  } catch (err) {
    res.status(500).send("Error deleting table");
  }
});

app.get("/table/:name", async (req, res) => {
  const tableName = req.params.name;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = [10, 25, 50, 100].includes(parseInt(req.query.limit))
    ? parseInt(req.query.limit)
    : 25;
  const offset = (page - 1) * limit;
  const search = req.query.q || "";

  try {
    const idCheck = await pool.query(
      `
      SELECT 1 FROM information_schema.columns 
      WHERE table_schema = 'public' 
        AND table_name = $1 
        AND column_name = 'id'
    `,
      [tableName],
    );

    if (idCheck.rows.length === 0) {
      console.log(`🔧 Adding missing 'id' column to table "${tableName}"...`);
      await pool.query(
        `ALTER TABLE "${tableName}" ADD COLUMN id SERIAL PRIMARY KEY`,
      );
      console.log(`✅ Added id column to "${tableName}"`);
    }

    const columnsRes = await pool.query(
      `
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `,
      [tableName],
    );

    let whereClause = "";
    let params = [];
    if (search) {
      const colNames = columnsRes.rows.map((c) => c.column_name);
      const conditions = colNames.map(
        (col, i) => `"${col}"::text ILIKE $${i + 1}`,
      );
      whereClause = `WHERE ${conditions.join(" OR ")}`;
      params = colNames.map(() => `%${search}%`);
    }

    const countRes = await pool.query(
      `
      SELECT COUNT(*) as total FROM "${tableName}" ${whereClause}
    `,
      params,
    );
    const totalRows = parseInt(countRes.rows[0].total);
    const totalPages = Math.ceil(totalRows / limit) || 1;

    const dataQuery = `
      SELECT * FROM "${tableName}" 
      ${whereClause} 
      ORDER BY id 
      LIMIT $${params.length + 1} 
      OFFSET $${params.length + 2}
    `;
    const dataRes = await pool.query(dataQuery, [...params, limit, offset]);

    res.render("table", {
      tableName,
      columns: columnsRes.rows,
      rows: dataRes.rows,
      currentPage: page,
      totalPages,
      totalRows,
      limit,
      searchTerm: search,
      hasPrev: page > 1,
      hasNext: page < totalPages,
      startRow: totalRows === 0 ? 0 : offset + 1,
      endRow: Math.min(offset + limit, totalRows),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading table: " + err.message);
  }
});

app.get("/table/:name/edit/:id", async (req, res) => {
  const tableName = req.params.name;
  const id = req.params.id;

  try {
    const columnsRes = await pool.query(
      `
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `,
      [tableName],
    );

    const rowRes = await pool.query(
      `SELECT * FROM "${tableName}" WHERE id = $1`,
      [id],
    );

    if (rowRes.rows.length === 0) return res.status(404).send("Row not found");

    res.render("edit", {
      tableName,
      id,
      columns: columnsRes.rows,
      row: rowRes.rows[0],
    });
  } catch (err) {
    res.status(500).send("Error loading edit form");
  }
});

app.post("/table/:name/update/:id", async (req, res) => {
  const tableName = req.params.name;
  const id = req.params.id;
  const data = req.body;

  try {
    const keys = Object.keys(data);
    const values = Object.values(data);

    const setClause = keys.map((k, i) => `"${k}" = $${i + 1}`).join(", ");

    await pool.query(
      `
      UPDATE "${tableName}" 
      SET ${setClause} 
      WHERE id = $${keys.length + 1}
    `,
      [...values, id],
    );

    res.redirect(`/table/${tableName}`);
  } catch (err) {
    res.status(500).send("Update error");
  }
});

app.post("/table/:name/insert", async (req, res) => {
  const tableName = req.params.name;
  const data = req.body;

  try {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");

    await pool.query(
      `
      INSERT INTO "${tableName}" (${keys.map((k) => `"${k}"`).join(", ")})
      VALUES (${placeholders})
    `,
      values,
    );
    res.redirect(`/table/${tableName}`);
  } catch (err) {
    res.status(500).send("Insert error");
  }
});

app.post("/table/:name/delete", async (req, res) => {
  const tableName = req.params.name;
  const { id } = req.body;

  try {
    await pool.query(`DELETE FROM "${tableName}" WHERE id = $1`, [id]);
    res.redirect(`/table/${tableName}`);
  } catch (err) {
    res.status(500).send("Delete error");
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
