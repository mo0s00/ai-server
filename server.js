console.log("🔥 THIS IS NEW CODE 🔥");
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// T: API 키 전달 확인 로그
console.log("API KEY:", ANTHROPIC_API_KEY);

app.post("/comment", async (req, res) => {
  try {
    const { prompt } = req.body;

    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-3-sonnet-20240229"
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

    // T: Claude 응답 안전 파싱
    let text = "댓글 생성 실패";

    if (
      response &&
      response.data &&
      response.data.content &&
      Array.isArray(response.data.content)
    ) {
      const item = response.data.content.find(
        (v) => v.type === "text"
      );

      if (item && item.text) {
        text = item.text;
      }
    }

    res.json({ text });

  } catch (e) {
    console.error("ERROR FULL:", e.response?.data || e.message);

    res.status(500).json({
      error: true,
      message: e.message,
      details: e.response?.data || null,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("server running on " + PORT);
});
