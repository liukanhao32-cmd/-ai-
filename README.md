# 多AI聊天台

一个窗口，让多个 AI 同处一室、互相传话。用来消灭「开好几个网页、来回复制粘贴」这个动作。

## 启动

**双击桌面上的「多AI聊天台」图标**，会弹出一个小控制面板：

- **启动 / 停止 / 打开网页** 三个按钮
- 顶部实时显示是否在运行、本月花了多少钱
- 关掉窗口时会问你，要不要把服务一并停掉

也可以双击 `launcher.cmd`（等价），或者纯命令行：

```
node server.mjs
```

服务跑起来后访问 http://127.0.0.1:7788

不想用界面时，也可以用命令行控制：

```
powershell -ExecutionPolicy Bypass -File launcher.ps1 -Action start
powershell -ExecutionPolicy Bypass -File launcher.ps1 -Action stop
powershell -ExecutionPolicy Bypass -File launcher.ps1 -Action status
```

## 第一次用：填密钥

1. 点左下角「设置」
2. 把各家的 API Key 粘进去，保存
3. 没填密钥的模型会灰着，不影响其他模型使用

密钥存在 `data/keys.json`，只在本地，不进代码。

## 怎么用

- **@ 点名**：输入 `@DeepSeek 你觉得呢`，它就会回答。可以同时 @ 多个，各自答各自的。
- **转发**：把鼠标放到任意一条 AI 回复上，点「转发」，选另一个 AI，它就会接着讨论。
- **上下文**：点左侧某个成员，可以看它「记得」什么，也能清空。
- **带全部上下文**：勾选后每次把整段对话都发过去（回答更连贯，但更贵）。
- **导出**：把当前对话存成 Markdown。

## 加一个新的 AI

改 `config/models.json`，在 `models` 数组里加一条：

```json
{
  "id": "kimi",
  "name": "Kimi",
  "color": "#f59e0b",
  "baseUrl": "https://api.moonshot.cn/v1",
  "model": "moonshot-v1-8k",
  "contextWindow": 8192,
  "inputPrice": 12,
  "outputPrice": 12,
  "note": "月之暗面"
}
```

刷新网页就生效，不用重启。

字段说明：

| 字段 | 含义 |
| --- | --- |
| `id` | 唯一标识，也是密钥的键名；同一个模型填两个不同 id 就是两个「人格」 |
| `name` | 界面上显示的名字，也是 @ 时输入的名字 |
| `baseUrl` | 接口地址，要兼容 OpenAI 的 `/chat/completions` |
| `model` | 模型名；豆包填方舟的 Model ID（如 `doubao-seed-2-1-pro-260915`）或自定义接入点 `ep-xxxx` |
| `color` | 头像颜色 |
| `inputPrice` / `outputPrice` | 元 / 百万 token，用于成本显示，填错了只是数字不准 |

## 成本与预算

- 每条回复下面显示这条花了多少钱
- 左侧显示本月累计，超过 80% 变黄，到 100% 变红并停止调用
- 预算在「设置」里改，默认 100 元/月

> 注意：AI 互聊的消耗是叠加的。开了「带全部上下文」后，每轮都会把整段历史重发一遍，费用增长很快。

## 文件结构

```
server.mjs          后端（零依赖，只用 Node 内置模块）
public/             前端
config/models.json  模型清单
config/settings.json 端口、预算
launcher.ps1        启停控制面板
launcher.cmd        双击入口（桌面图标指向它）
assets/app.ico      图标
data/keys.json      密钥（自动生成）
data/usage.json     本月用量（自动生成）
data/sessions/      对话历史，一个对话一个文件
data/calls.jsonl    每次调用的明细
data/server.log     服务运行日志
```

## 还没做的

- WorkBuddy / ecode 接入（架构已预留 agent 任务卡，下个版本）
- 自动接力（AI 之间自己聊）
- 角色预设（给每个 AI 固定人设）

## 安全

- 只监听 127.0.0.1，同一局域网的其他设备访问不到
- 密钥不回显到页面，也不写进日志
- 对话记录存在浏览器本地
