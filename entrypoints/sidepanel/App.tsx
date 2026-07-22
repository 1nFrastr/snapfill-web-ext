import { FormEvent, useEffect, useRef, useState } from 'react';
import './App.css';

type Role = 'user' | 'assistant';

type Message = {
  id: string;
  role: Role;
  text: string;
};

const INITIAL_MESSAGES: Message[] = [
  {
    id: '1',
    role: 'assistant',
    text: '你好，我是 Snapfill。把表单需求发给我，我来帮你填写。',
  },
];

function App() {
  const [messages, setMessages] = useState<Message[]>(INITIAL_MESSAGES);
  const [input, setInput] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text) return;

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      text,
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');

    window.setTimeout(() => {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          text: '收到。对话能力还在接入中，这里先确认侧边栏交互正常。',
        },
      ]);
    }, 450);
  }

  return (
    <div className="chat">
      <header className="chat__header">
        <div className="chat__brand">Snapfill</div>
        <p className="chat__slogan">hello world</p>
      </header>

      <div className="chat__messages" ref={listRef}>
        {messages.map((message) => (
          <div
            key={message.id}
            className={`bubble bubble--${message.role}`}
          >
            {message.text}
          </div>
        ))}
      </div>

      <form className="composer" onSubmit={handleSubmit}>
        <textarea
          className="composer__input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="描述要填的内容…"
          rows={1}
        />
        <button className="composer__send" type="submit" disabled={!input.trim()}>
          发送
        </button>
      </form>
    </div>
  );
}

export default App;
