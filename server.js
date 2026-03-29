const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const OPENAI_KEY = process.env.OPENAI_KEY;

app.post("/comment", async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "prompt required" });
    }

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "댓글 작성" },
          { role: "user", content: prompt },
        ],
        max_tokens: 100,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      }
    );

    res.json({
      text: response.data.choices[0].message.content,
    });

  } catch (e) {
    console.error("ERROR:", e.message);

    res.status(500).json({
      error: "fail",
      detail: e.message,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("server running on " + PORT);
});