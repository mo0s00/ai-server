const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

app.post("/comment", async (req, res) => {
  try {
    const { prompt } = req.body;

    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-5",
        max_tokens: 500,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
      },
      {
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        timeout: 8000,
      }
    );

    let text = "댓글 생성 실패";

    if (response.data && response.data.content && response.data.content.length > 0) {
      text = response.data.content[0].text || text;
    }

    res.json({ text });
  } catch (e) {
    console.error("ERROR:", e.response?.data || e.message);

    res.status(500).json({
      text: "서버 오류",
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("server running on " + PORT);
});
