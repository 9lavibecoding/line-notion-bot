const { Client: NotionClient } = require("@notionhq/client");

// --- Config ---
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

const notion = new NotionClient({ auth: NOTION_API_KEY });

// --- Line API Helpers ---
const COLORS = {
  primary: "#4A90D9",
  success: "#27AE60",
  error: "#E74C3C",
  warning: "#F39C12",
  muted: "#888888",
  bg: "#F7F8FA",
  textDark: "#1A1A1A",
  textLight: "#666666",
};

async function replyMessage(replyToken, messages) {
  if (typeof messages === "string") {
    messages = [{ type: "text", text: messages }];
  } else if (!Array.isArray(messages)) {
    messages = [messages];
  }
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error("LINE API error:", res.status, JSON.stringify(err));
  }
}

function statusCard(title, subtitle, color) {
  const bubble = {
    type: "bubble", size: "mega",
    body: {
      type: "box", layout: "vertical", paddingAll: "16px",
      contents: [
        {
          type: "box", layout: "vertical",
          borderWidth: "2px", borderColor: color,
          cornerRadius: "8px", paddingAll: "md",
          contents: [
            { type: "text", text: title, color: color, weight: "bold", size: "md", wrap: true },
            ...(subtitle ? [{
              type: "text", text: subtitle, size: "sm", color: COLORS.textLight, wrap: true, margin: "sm",
            }] : []),
          ],
        },
      ],
    },
  };
  return { type: "flex", altText: title, contents: bubble };
}

function draftCard(title, subtitle) {
  const bubble = {
    type: "bubble", size: "mega",
    body: {
      type: "box", layout: "vertical", paddingAll: "0px",
      contents: [
        {
          type: "box", layout: "horizontal", backgroundColor: COLORS.primary,
          paddingAll: "14px", alignItems: "center",
          contents: [
            {
              type: "box", layout: "vertical", width: "6px", height: "6px",
              cornerRadius: "3px", backgroundColor: "#FFFFFF", flex: 0,
            },
            { type: "text", text: "收集中", size: "xs", weight: "bold", color: "#FFFFFF", margin: "sm", flex: 0 },
            { type: "filler" },
            { type: "text", text: title, size: "xs", color: "#C8DEFF", flex: 0 },
          ],
        },
        {
          type: "box", layout: "vertical", paddingAll: "16px", backgroundColor: "#F0F6FF",
          contents: [
            { type: "text", text: subtitle, size: "sm", color: COLORS.textDark, wrap: true },
          ],
        },
        {
          type: "box", layout: "horizontal", paddingAll: "12px", spacing: "md", backgroundColor: "#FFFFFF",
          contents: [
            {
              type: "button", style: "primary", color: COLORS.success, height: "sm", flex: 1,
              action: { type: "message", label: "儲存待辦", text: "/save" },
            },
            {
              type: "button", style: "secondary", height: "sm", flex: 1,
              action: { type: "message", label: "取消", text: "/cancel" },
            },
          ],
        },
      ],
    },
  };
  return { type: "flex", altText: title, contents: bubble };
}

async function getImageBuffer(messageId) {
  const res = await fetch(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    {
      headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
    }
  );
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// --- Temporary Image Host ---
async function uploadToImgbb(buffer) {
  const IMGBB_API_KEY = process.env.IMGBB_API_KEY;
  if (!IMGBB_API_KEY) return null;

  const base64 = buffer.toString("base64");
  const formData = new URLSearchParams();
  formData.append("key", IMGBB_API_KEY);
  formData.append("image", base64);

  const res = await fetch("https://api.imgbb.com/1/upload", {
    method: "POST",
    body: formData,
  });
  const data = await res.json();
  return data?.data?.url || null;
}

// --- Draft Helpers (use Notion as temp storage) ---
// 草稿 = Notion page with Select = "草稿"
async function getDraft(userId) {
  const res = await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
    filter: {
      and: [
        { property: "Select", rich_text: { equals: "草稿:" + userId } },
        { property: "Checkbox", checkbox: { equals: false } },
      ],
    },
    page_size: 1,
  });
  return res.results[0] || null;
}

async function createDraft(userId) {
  return notion.pages.create({
    parent: { database_id: NOTION_DATABASE_ID },
    properties: {
      Title: { title: [{ text: { content: "（收集中...）" } }] },
      Checkbox: { checkbox: false },
      Select: { rich_text: [{ text: { content: "草稿:" + userId } }] },
    },
  });
}

async function getOrCreateDraft(userId) {
  let draft = await getDraft(userId);
  if (!draft) {
    draft = await createDraft(userId);
  }
  return draft;
}

async function updateDraftTitle(draft, title) {
  const currentTitle =
    draft.properties["Title"]?.title?.[0]?.plain_text || "";
  const newTitle =
    currentTitle === "（收集中...）" ? title : currentTitle + " | " + title;

  await notion.pages.update({
    page_id: draft.id,
    properties: {
      Title: { title: [{ text: { content: newTitle } }] },
    },
  });
  return newTitle;
}

async function addImageToDraft(pageId, imageUrl) {
  await notion.blocks.children.append({
    block_id: pageId,
    children: [
      {
        object: "block",
        type: "image",
        image: { type: "external", external: { url: imageUrl } },
      },
    ],
  });
}

async function setDraftDate(pageId, dateStr) {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      完成日期: { date: { start: dateStr } },
    },
  });
}

async function finalizeDraft(userId) {
  const draft = await getDraft(userId);
  if (!draft) return null;

  const title =
    draft.properties["Title"]?.title?.[0]?.plain_text || "（無標題）";

  await notion.pages.update({
    page_id: draft.id,
    properties: {
      Select: { rich_text: [{ text: { content: "Line Bot" } }] },
    },
  });

  return title;
}

// --- Notion Helpers ---
async function createTodo(title) {
  return notion.pages.create({
    parent: { database_id: NOTION_DATABASE_ID },
    properties: {
      Title: { title: [{ text: { content: title } }] },
      Checkbox: { checkbox: false },
      Select: { rich_text: [{ text: { content: "Line Bot" } }] },
    },
  });
}

async function getTodoImage(pageId) {
  try {
    const res = await notion.blocks.children.list({ block_id: pageId, page_size: 5 });
    const imageBlock = res.results.find(b => b.type === "image");
    if (!imageBlock) return null;
    return imageBlock.image?.external?.url || imageBlock.image?.file?.url || null;
  } catch {
    return null;
  }
}

async function listTodos() {
  const res = await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
    filter: {
      and: [
        { property: "Checkbox", checkbox: { equals: false } },
        {
          property: "Select",
          rich_text: { does_not_contain: "草稿:" },
        },
      ],
    },
    sorts: [{ timestamp: "created_time", direction: "descending" }],
    page_size: 10,
  });

  return res.results.map((page) => ({
    id: page.id,
    title: page.properties["Title"]?.title?.[0]?.plain_text || "（無標題）",
  }));
}

async function completeTodo(index) {
  const res = await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
    filter: {
      and: [
        { property: "Checkbox", checkbox: { equals: false } },
        {
          property: "Select",
          rich_text: { does_not_contain: "草稿:" },
        },
      ],
    },
    sorts: [{ timestamp: "created_time", direction: "descending" }],
    page_size: 10,
  });

  const page = res.results[index - 1];
  if (!page) return null;

  await notion.pages.update({
    page_id: page.id,
    properties: {
      Checkbox: { checkbox: true },
      完成日期: { date: { start: new Date().toISOString() } },
    },
  });

  const title =
    page.properties["Title"]?.title?.[0]?.plain_text || "（無標題）";
  return title;
}

async function deleteTodo(index) {
  const res = await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
    filter: {
      and: [
        { property: "Checkbox", checkbox: { equals: false } },
        { property: "Select", rich_text: { does_not_contain: "草稿:" } },
      ],
    },
    sorts: [{ timestamp: "created_time", direction: "descending" }],
    page_size: 10,
  });

  const page = res.results[index - 1];
  if (!page) return null;

  await notion.pages.update({
    page_id: page.id,
    properties: {
      Checkbox: { checkbox: true },
      Select: { rich_text: [{ text: { content: "已刪除" } }] },
    },
  });
  return page.properties["Title"]?.title?.[0]?.plain_text || "（無標題）";
}

async function setTodoDateByIndex(index, dateStr) {
  const res = await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
    filter: {
      and: [
        { property: "Checkbox", checkbox: { equals: false } },
        { property: "Select", rich_text: { does_not_contain: "草稿:" } },
      ],
    },
    sorts: [{ timestamp: "created_time", direction: "descending" }],
    page_size: 10,
  });

  const page = res.results[index - 1];
  if (!page) return null;

  await notion.pages.update({
    page_id: page.id,
    properties: { 完成日期: { date: { start: dateStr } } },
  });
  return page.properties["Title"]?.title?.[0]?.plain_text || "（無標題）";
}

async function getEditSession(userId) {
  const res = await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
    filter: {
      and: [
        { property: "Select", rich_text: { equals: "編輯:" + userId } },
        { property: "Checkbox", checkbox: { equals: false } },
      ],
    },
    page_size: 1,
  });
  return res.results[0] || null;
}

async function createEditSession(userId, targetPageId) {
  return notion.pages.create({
    parent: { database_id: NOTION_DATABASE_ID },
    properties: {
      Title: { title: [{ text: { content: targetPageId } }] },
      Checkbox: { checkbox: false },
      Select: { rich_text: [{ text: { content: "編輯:" + userId } }] },
    },
  });
}

async function clearEditSession(sessionPageId) {
  await notion.pages.update({
    page_id: sessionPageId,
    properties: { Checkbox: { checkbox: true } },
  });
}

async function appendTextToPage(pageId, text) {
  await notion.blocks.children.append({
    block_id: pageId,
    children: [{
      object: "block", type: "paragraph",
      paragraph: { rich_text: [{ text: { content: text } }] },
    }],
  });
}

// --- Date Detection ---
function parseDate(text) {
  // 支援格式: 2026-03-20, 2026/03/20, 03-20, 03/20
  const fullMatch = text.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (fullMatch) return `${fullMatch[1]}-${fullMatch[2].padStart(2, "0")}-${fullMatch[3].padStart(2, "0")}`;

  const shortMatch = text.match(/^(\d{1,2})[/-](\d{1,2})$/);
  if (shortMatch) {
    const year = new Date().getFullYear();
    return `${year}-${shortMatch[1].padStart(2, "0")}-${shortMatch[2].padStart(2, "0")}`;
  }
  return null;
}

// --- Event Handler ---
async function handleEvent(event) {
  const replyToken = event.replyToken;
  const userId = event.source?.userId || "unknown";

  if (event.type === "message" && event.message.type === "text") {
    const text = event.message.text.trim();

    // /save — 儲存草稿 or 結束編輯
    if (text === "/save") {
      const editSession = await getEditSession(userId);
      if (editSession) {
        await clearEditSession(editSession.id);
        return replyMessage(replyToken, statusCard("已儲存追加內容", "內容已更新到 Notion", COLORS.success));
      }
      const title = await finalizeDraft(userId);
      if (title) {
        return replyMessage(replyToken, statusCard("已儲存待辦", title, COLORS.success));
      }
      return replyMessage(replyToken, statusCard("沒有正在收集的待辦", "請先傳送文字或圖片開始收集", COLORS.error));
    }

    // /cancel — 取消草稿 or 結束編輯
    if (text === "/cancel") {
      const editSession = await getEditSession(userId);
      if (editSession) {
        await clearEditSession(editSession.id);
        return replyMessage(replyToken, statusCard("已取消編輯", "", COLORS.warning));
      }
      const draft = await getDraft(userId);
      if (draft) {
        await notion.pages.update({ page_id: draft.id, properties: { Checkbox: { checkbox: true } } });
        return replyMessage(replyToken, statusCard("已取消收集", "草稿已刪除", COLORS.warning));
      }
      return replyMessage(replyToken, statusCard("沒有正在收集的待辦", "目前沒有需要取消的項目", COLORS.error));
    }

    // /list
    if (text === "/list") {
      const todos = await listTodos();
      if (todos.length === 0) {
        return replyMessage(replyToken, statusCard("沒有未完成的待辦", "所有事項都已完成！", COLORS.success));
      }

      const images = await Promise.all(todos.map(t => getTodoImage(t.id)));

      const bubbles = todos.map((todo, i) => {
        const imageUrl = images[i];
        return {
          type: "bubble", size: "kilo",
          ...(imageUrl ? {
            hero: {
              type: "image", url: imageUrl,
              size: "full", aspectRatio: "20:13", aspectMode: "cover",
            },
          } : {}),
          body: {
            type: "box", layout: "vertical", paddingAll: "16px", spacing: "sm",
            contents: [
              {
                type: "box", layout: "horizontal", alignItems: "center", spacing: "sm",
                contents: [
                  {
                    type: "box", layout: "vertical", width: "20px", height: "20px",
                    cornerRadius: "10px", backgroundColor: COLORS.primary, flex: 0,
                    justifyContent: "center", alignItems: "center",
                    contents: [{ type: "text", text: `${i + 1}`, size: "xxs", color: "#FFFFFF", align: "center" }],
                  },
                  { type: "text", text: todo.title, size: "sm", color: COLORS.textDark, wrap: true, flex: 1 },
                ],
              },
            ],
          },
          styles: { footer: { separator: true } },
          footer: {
            type: "box", layout: "vertical", spacing: "sm", paddingAll: "12px",
            contents: [
              {
                type: "button", style: "primary", color: COLORS.success, height: "sm",
                action: { type: "postback", label: "✓ 完成", data: `action=done&id=${todo.id}`, displayText: "✓ 完成" },
              },
              {
                type: "box", layout: "horizontal", spacing: "sm",
                contents: [
                  {
                    type: "button", style: "secondary", color: COLORS.primary, height: "sm", flex: 1,
                    action: { type: "postback", label: "✎ 編輯", data: `action=edit&id=${todo.id}`, displayText: "✎ 進入編輯" },
                  },
                  {
                    type: "button", style: "secondary", height: "sm", flex: 1,
                    action: { type: "postback", label: "✕ 刪除", data: `action=delete&id=${todo.id}`, displayText: "✕ 刪除" },
                  },
                ],
              },
            ],
          },
        };
      });

      const carousel = { type: "carousel", contents: bubbles };
      return replyMessage(replyToken, [
        { type: "text", text: `📋 未完成待辦 · 共 ${todos.length} 項` },
        { type: "flex", altText: "未完成待辦", contents: carousel },
      ]);
    }

    // /done N
    const doneMatch = text.match(/^\/done\s+(\d+)$/);
    if (doneMatch) {
      const index = parseInt(doneMatch[1]);
      const title = await completeTodo(index);
      if (title) {
        return replyMessage(replyToken, statusCard("已完成 ✓", title, COLORS.success));
      }
      return replyMessage(replyToken, statusCard("找不到該項目", "請用 /list 確認編號", COLORS.error));
    }

    // /delete N
    const deleteMatch = text.match(/^\/delete\s+(\d+)$/);
    if (deleteMatch) {
      const index = parseInt(deleteMatch[1]);
      const title = await deleteTodo(index);
      if (title) {
        return replyMessage(replyToken, statusCard("已刪除", title, COLORS.warning));
      }
      return replyMessage(replyToken, statusCard("找不到該項目", "請用 /list 確認編號", COLORS.error));
    }

    // /date N 日期
    const dateIndexMatch = text.match(/^\/date\s+(\d+)\s+(.+)$/);
    if (dateIndexMatch) {
      const index = parseInt(dateIndexMatch[1]);
      const dateStr = parseDate(dateIndexMatch[2].trim());
      if (!dateStr) {
        return replyMessage(replyToken, statusCard("日期格式不正確", "請使用 YYYY-MM-DD 或 MM-DD", COLORS.error));
      }
      const title = await setTodoDateByIndex(index, dateStr);
      if (title) {
        return replyMessage(replyToken, statusCard("已設定截止日期", `${title}\n${dateStr}`, COLORS.success));
      }
      return replyMessage(replyToken, statusCard("找不到該項目", "請用 /list 確認編號", COLORS.error));
    }

    // /help
    if (text === "/help") {
      const makeHelpBubble = (color, emoji, sectionTitle, rows) => ({
        type: "bubble", size: "mega",
        body: {
          type: "box", layout: "vertical", paddingAll: "0px",
          contents: [
            {
              type: "box", layout: "vertical", backgroundColor: color, paddingAll: "20px",
              contents: [
                { type: "text", text: emoji, size: "xxl" },
                { type: "text", text: sectionTitle, size: "xl", weight: "bold", color: "#FFFFFF", margin: "sm" },
              ],
            },
            {
              type: "box", layout: "vertical", paddingAll: "16px", spacing: "md",
              contents: rows.map(([cmd, desc]) => ({
                type: "box", layout: "horizontal", spacing: "md",
                contents: [
                  { type: "text", text: cmd, size: "sm", weight: "bold", color: color, flex: 2 },
                  { type: "text", text: desc, size: "sm", color: COLORS.textLight, flex: 3, wrap: true },
                ],
              })),
            },
          ],
        },
      });

      const helpCarousel = {
        type: "carousel",
        contents: [
          makeHelpBubble(COLORS.primary, "📝", "新增待辦", [
            ["直接傳文字", "立即新增一筆待辦"],
            ["傳送圖片", "進入多段收集模式"],
            ["傳日期", "04-30 或 2026-04-30\n在草稿中設截止日"],
          ]),
          makeHelpBubble(COLORS.warning, "📦", "收集模式", [
            ["/save", "儲存目前收集的草稿"],
            ["/cancel", "放棄目前草稿"],
          ]),
          makeHelpBubble(COLORS.success, "📋", "管理清單", [
            ["/list", "查看未完成清單\n每項有完成/刪除按鈕"],
            ["/done 1", "完成第 1 項"],
            ["/delete 1", "刪除第 1 項"],
            ["/date 1 04-30", "設定第 1 項截止日"],
            ["/edit 1", "追加文字/圖片/日期\n到第 1 筆待辦"],
          ]),
        ],
      };
      return replyMessage(replyToken, { type: "flex", altText: "使用說明", contents: helpCarousel });
    }

    // /edit N
    const editMatch = text.match(/^\/edit\s+(\d+)$/);
    if (editMatch) {
      const index = parseInt(editMatch[1]);
      const [existingDraft, existingEdit] = await Promise.all([getDraft(userId), getEditSession(userId)]);
      if (existingDraft || existingEdit) {
        return replyMessage(replyToken, statusCard("目前有進行中的操作", "請先 /save 或 /cancel 完成後再編輯", COLORS.warning));
      }
      const res = await notion.databases.query({
        database_id: NOTION_DATABASE_ID,
        filter: {
          and: [
            { property: "Checkbox", checkbox: { equals: false } },
            { property: "Select", rich_text: { does_not_contain: "草稿:" } },
          ],
        },
        sorts: [{ timestamp: "created_time", direction: "descending" }],
        page_size: 10,
      });
      const page = res.results[index - 1];
      if (!page) return replyMessage(replyToken, statusCard("找不到該項目", "請用 /list 確認編號", COLORS.error));
      const title = page.properties["Title"]?.title?.[0]?.plain_text || "（無標題）";
      await createEditSession(userId, page.id);
      return replyMessage(replyToken, draftCard("編輯中", `📝 ${title}\n\n可繼續傳送文字/圖片/日期追加內容，完成後 /save`));
    }

    // 未知指令（/ 開頭但不符合任何指令）
    if (text.startsWith("/")) {
      return replyMessage(replyToken, statusCard("未知指令", `「${text}」不是有效指令，輸入 /help 查看說明`, COLORS.error));
    }

    // 查草稿與編輯狀態（並行）
    const dateStr = parseDate(text);
    const [draft, editSession] = await Promise.all([getDraft(userId), getEditSession(userId)]);

    // 編輯模式 → 追加到目標頁面
    if (editSession) {
      const targetPageId = editSession.properties["Title"]?.title?.[0]?.plain_text;
      if (dateStr) {
        await setDraftDate(targetPageId, dateStr);
        return replyMessage(replyToken, draftCard("已設定截止日期", dateStr));
      }
      await appendTextToPage(targetPageId, text);
      return replyMessage(replyToken, draftCard("已追加備註", `📝 ${text}\n\n可繼續傳送，或 /save 完成`));
    }

    // 日期格式 → 設定草稿日期
    if (dateStr && draft) {
      await setDraftDate(draft.id, dateStr);
      return replyMessage(replyToken, draftCard("已設定日期", dateStr));
    }

    // 有草稿 → 加入草稿
    if (draft) {
      const fullTitle = await updateDraftTitle(draft, text);
      return replyMessage(replyToken, draftCard("已加入收集", `📋 ${fullTitle}\n\n可繼續傳送文字/圖片/日期，或按下方按鈕儲存`));
    }

    // 沒有草稿 → 直接建立單筆待辦
    await createTodo(text);
    return replyMessage(replyToken, statusCard("已新增待辦", text, COLORS.primary));
  }

  // postback → 完成 / 刪除（來自 /list 按鈕）
  if (event.type === "postback") {
    const params = new URLSearchParams(event.postback.data);
    const action = params.get("action");
    const pageId = params.get("id");

    if (action === "done") {
      const [page] = await Promise.all([
        notion.pages.retrieve({ page_id: pageId }),
        notion.pages.update({
          page_id: pageId,
          properties: {
            Checkbox: { checkbox: true },
            完成日期: { date: { start: new Date().toISOString() } },
          },
        }),
      ]);
      const title = page.properties["Title"]?.title?.[0]?.plain_text || "（無標題）";
      return replyMessage(replyToken, statusCard("已完成 ✓", title, COLORS.success));
    }

    if (action === "delete") {
      const [page] = await Promise.all([
        notion.pages.retrieve({ page_id: pageId }),
        notion.pages.update({
          page_id: pageId,
          properties: {
            Checkbox: { checkbox: true },
            Select: { rich_text: [{ text: { content: "已刪除" } }] },
          },
        }),
      ]);
      const title = page.properties["Title"]?.title?.[0]?.plain_text || "（無標題）";
      return replyMessage(replyToken, statusCard("已刪除", title, COLORS.warning));
    }

    if (action === "edit") {
      const [existingDraft, existingEdit] = await Promise.all([getDraft(userId), getEditSession(userId)]);
      if (existingDraft || existingEdit) {
        return replyMessage(replyToken, statusCard("目前有進行中的操作", "請先 /save 或 /cancel 完成後再編輯", COLORS.warning));
      }
      const page = await notion.pages.retrieve({ page_id: pageId });
      const title = page.properties["Title"]?.title?.[0]?.plain_text || "（無標題）";
      await createEditSession(userId, pageId);
      return replyMessage(replyToken, draftCard("進入編輯模式", `📝 ${title}\n\n請直接傳送想追加的文字、圖片或日期。\n完成後請按儲存，或輸入 /save`));
    }
  }

  // 圖片 → 自動開始收集模式
  if (event.type === "message" && event.message.type === "image") {
    const messageId = event.message.id;
    try {
      // 下載圖片、查草稿、查編輯狀態並行
      const [buffer, existingDraft, existingEdit] = await Promise.all([
        getImageBuffer(messageId),
        getDraft(userId),
        getEditSession(userId),
      ]);
      const [imageUrl] = await Promise.all([uploadToImgbb(buffer)]);

      if (!imageUrl) {
        return replyMessage(replyToken, statusCard("圖片上傳失敗", "請稍後再試", COLORS.error));
      }

      // 編輯模式 → 追加圖片到目標頁面
      if (existingEdit) {
        const targetPageId = existingEdit.properties["Title"]?.title?.[0]?.plain_text;
        await addImageToDraft(targetPageId, imageUrl);
        return replyMessage(replyToken, draftCard("已追加圖片", "可繼續傳送，或 /save 完成"));
      }

      // 草稿模式
      const draft = existingDraft || await createDraft(userId);
      await addImageToDraft(draft.id, imageUrl);
      return replyMessage(replyToken, draftCard("圖片已加入", "可繼續傳送文字/圖片/日期，或按下方按鈕儲存"));
    } catch (err) {
      console.error("Image error:", err.message);
      return replyMessage(replyToken, statusCard("圖片處理失敗", err.message, COLORS.error));
    }
  }
}

// --- Vercel Serverless Handler ---
module.exports = async (req, res) => {
  if (req.method === "GET") {
    return res.status(200).send("Line Notion Bot is running!");
  }

  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const events = req.body?.events || [];

  for (const event of events) {
    try {
      await handleEvent(event);
    } catch (err) {
      console.error("Event handling error:", err.message);
    }
  }

  return res.status(200).json({ status: "ok" });
};
