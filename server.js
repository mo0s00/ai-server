const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const OPENAI_KEY = process.env.OPENAI_KEY;

app.post("/comment", async (req, res) => {
  try {
    const { prompt } = req.body;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "댓글 작성" },
          { role: "user", content: prompt },
        ],
        max_tokens: 200,
      }),
    });

    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "server error" });
  }
});

app.listen(3000, () => {
    console.log("server running on 3000");
  });