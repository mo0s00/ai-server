import express from 'express'
import cors from 'cors'
import { createClient } from '@supabase/supabase-js'

const app = express()
app.use(cors())
app.use(express.json())

// T: 환경변수로 Supabase 연결 (배포용)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// T: 서버 상태 확인
app.get('/health', (req, res) => {
  res.json({ ok: true })
})

// T: 피메모 저장
app.post('/memo', async (req, res) => {
  const { user_id, content } = req.body

  if (!user_id || !content) {
    return res.status(400).json({ error: 'missing data' })
  }

  const { data, error } = await supabase
    .from('memos')
    .insert([{ user_id, content }])
    .select()

  if (error) return res.status(500).json({ error })

  res.json(data[0])
})

// T: 댓글 저장
app.post('/comment', async (req, res) => {
  const { memo_id, role, content } = req.body

  if (!memo_id || !content) {
    return res.status(400).json({ error: 'missing data' })
  }

  const { error } = await supabase
    .from('comments')
    .insert([{ memo_id, role, content }])

  if (error) return res.status(500).json({ error })

  res.json({ ok: true })
})

// T: 피메모 목록 (최신 20개)
app.get('/memos/:user_id', async (req, res) => {
  const { user_id } = req.params

  const { data, error } = await supabase
    .from('memos')
    .select('*')
    .eq('user_id', user_id)
    .order('created_at', { ascending: false })
    .limit(20)

  if (error) return res.status(500).json({ error })

  res.json(data)
})

// T: 댓글 불러오기
app.get('/comments/:memo_id', async (req, res) => {
  const { memo_id } = req.params

  const { data, error } = await supabase
    .from('comments')
    .select('*')
    .eq('memo_id', memo_id)
    .order('created_at', { ascending: true })

  if (error) return res.status(500).json({ error })

  res.json(data)
})

// T: 서버 실행
const PORT = process.env.PORT || 3000
app.listen(PORT, '0.0.0.0', () => {
  console.log('server running on', PORT)
})