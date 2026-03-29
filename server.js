const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const OPENAI_KEY = process.env.OPENAI_KEY;

app.post("/comment", async (req, res) => {
  try {
    const { prompt } = req.body;

    const response = await axios.post(
      "https://api.openai.com/v1/responses",
      {
        model: "gpt-4o-mini",
        input: `댓글 작성: ${prompt}`,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 8000, // 🔥 더 짧게
      }
    );

    res.json({
      text: response.data.output[0].content[0].text,
    });

  } catch (e) {
    console.error("ERROR:", e.response?.data || e.message);

    res.status(500).json({
      error: "fail",
      detail: e.response?.data || e.message,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("server running on " + PORT);
});