import express from "express";

const app = express();
const PORT = 5050;

app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    message: "API is running",
  });
});

app.get("/api/users", (req, res) => {
  res.json([
    { id: 1, name: "Tushar" },
    { id: 2, name: "John" },
  ]);
});

app.post("/api/users", (req, res) => {
  const { name } = req.body;

  res.status(201).json({
    message: "User created",
    user: { name },
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
