import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";

export async function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Nhập mật khẩu không hiển thị trên terminal. Khi stdin không phải TTY
 * (pipe/CI), đọc một dòng như promptLine; ưu tiên truyền qua biến môi trường
 * để không lộ mật khẩu trong lịch sử shell.
 */
export async function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return promptLine(question);
  }

  process.stdout.write(question);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise<string>((resolve, reject) => {
    let value = "";

    const cleanup = () => {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };

    const onKeypress = (input: string, key: { name?: string; ctrl?: boolean; meta?: boolean } = {}) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        process.stdout.write("\n");
        reject(new Error("Đã hủy."));
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        process.stdout.write("\n");
        resolve(value);
        return;
      }
      if (key.name === "backspace") {
        if (value.length > 0) value = value.slice(0, -1);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        value += input;
      }
    };

    process.stdin.on("keypress", onKeypress);
  });
}
