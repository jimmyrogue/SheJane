# Atlas · AI Agent Desktop UI 设计规范

> Electron + shadcn 桌面 AI Agent 应用 UI 设计文档
> 对标 Codex Desktop / Claude Desktop · 黑白灰主调 + 莫兰迪色点缀

---

## 1. 设计原则

1. **白底黑字优先** — 主内容区永远是纯白 `#FFFFFF`，文字使用近黑 `#2C2C2A` 而非纯黑，更柔和。
2. **0.5px hairline** — 所有分隔线、边框使用 0.5px 极细灰线，避免视觉沉重。
3. **暖灰底色** — 侧栏、二级表面使用带一丝暖意的灰 `#F4F3F0`、`#F8F7F4`，比中性灰更舒适。
4. **莫兰迪点缀** — 仅在状态语义处用色（成功、警告、危险），且优先使用低饱和的莫兰迪绿/驼/红。
5. **小圆角节奏** — 卡片 12px、按钮和输入 8px、状态 pill 6px，层级清晰。
6. **macOS 原生感** — Traffic light 三圆灯 + 居中标题栏，让应用有桌面级质感。

---

## 2. 色彩系统（Design Tokens）

### 2.1 中性色 — 主色调

| Token | 值 | 用途 |
|---|---|---|
| `--bg-app` | `#FAFAF9` | 应用底色（窗口外缘） |
| `--bg-sidebar` | `#F4F3F0` | 侧边栏、标题栏 |
| `--bg-sidebar-soft` | `#F8F7F4` | 任务面板等次级表面 |
| `--bg-surface` | `#FFFFFF` | 主内容区、卡片底 |
| `--text-primary` | `#2C2C2A` | 主文字、按钮主色 |
| `--text-secondary` | `#5F5E5A` | 次要文字、图标 |
| `--text-tertiary` | `#A8A6A0` | 提示文字、时间戳 |
| `--border-hairline` | `rgba(0,0,0,0.08)` | 默认 0.5px 边框 |
| `--border-strong` | `rgba(0,0,0,0.16)` | 悬停、强调边框 |

### 2.2 莫兰迪点缀色 — 语义状态

每组色由 fill + bg + text 三个分量组成。

| 语义 | Token | 值 | 用途场景 |
|---|---|---|---|
| 成功 | `--accent-success` | `#8FA682` | 状态点、active 开关 |
| | `--accent-success-bg` | `#E8EDE4` | 浅底 pill |
| | `--accent-success-text` | `#4F6342` | 浅底上的文字 |
| 警告 | `--accent-warning` | `#C99A6B` | 运行中、加载中 |
| | `--accent-warning-bg` | `#FBF1E2` | 卡片底、tip 提示 |
| | `--accent-warning-text` | `#8B6A47` | 浅底上的文字 |
| 危险 | `--accent-danger` | `#B8716C` | 错误、auth 失败 |
| | `--accent-danger-bg` | `#FBF0EF` | 错误卡片底 |
| | `--accent-danger-border` | `#E3A8A4` | 错误卡片描边 |
| | `--accent-danger-text` | `#8B3E3A` | 浅底上的文字 |
| 信息 | `--accent-info` | `#4A6B8A` | 链接、研究类标签 |

### 2.3 辅助色

| Token | 值 | 用途 |
|---|---|---|
| `--avatar-bg` | `#C9B8A2` | 用户头像底色（暖驼） |
| `--avatar-text` | `#3D2F1F` | 头像字母 |

### 2.4 Traffic light（窗口控件）

| 颜色 | 值 |
|---|---|
| 红 (关闭) | `#E8918C` |
| 黄 (最小化) | `#E5C079` |
| 绿 (全屏) | `#A8C49A` |

---

## 3. 排版

### 3.1 字体栈

```css
--font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter",
             "Helvetica Neue", "PingFang SC", sans-serif;
--font-mono: "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
```

### 3.2 字号 / 字重

| 用途 | size | weight | line-height |
|---|---|---|---|
| 页面 H1 | 18px | 500 | 1.4 |
| 卡片标题 | 13px | 500 | 1.5 |
| 正文 | 13px | 400 | 1.65 |
| 次要文字 / 描述 | 12px | 400 | 1.55 |
| 提示 / 时间戳 | 11px | 400 | 1.4 |
| 状态 pill | 11px | 400 | 1 |
| 小标签（uppercase） | 11px | 400, `letter-spacing: 0.6px` | — |
| 代码 / mono | 11–12px | 400 | 1.7 |

**只用两种字重：400 和 500。** 不用 600/700——过于厚重，与 hairline 边框不搭。

---

## 4. 间距 / 圆角

### 4.1 圆角

| Token | 值 | 用途 |
|---|---|---|
| `--radius-sm` | 6px | pill、小 chip 按钮 |
| `--radius-md` | 8px | 按钮、输入框、设置项 |
| `--radius-lg` | 12px | 卡片、窗口外框、工具调用卡片 |
| `--radius-xl` | 16px | 大对话框（暂未使用） |

### 4.2 间距系统

垂直节奏使用 rem，组件内 gap 用 px：

- 区段间距：`56px`（section-bottom）
- 卡片内 padding：`14–22px`
- 列表项 gap：`8–12px`
- 内嵌元素 gap：`6–10px`

---

## 5. 核心组件

### 5.1 窗口外框（Window Chrome）

每个页面都套一层带 traffic light 的窗口，模拟桌面应用感。

```
┌─ Titlebar (bg-sidebar, 0.5px bottom border) ──────┐
│ ● ● ●          Atlas · AI Agent          ⌘ 🔍   │
├───────────────────────────────────────────────────┤
│                                                   │
│                 主内容区                          │
│                                                   │
└───────────────────────────────────────────────────┘
```

- Traffic light 直径 11px，间距 6px
- 标题栏高度 ~36px，居中显示当前页面/任务名
- 右侧可放 1–2 个轻量操作图标

### 5.2 主侧边栏（Primary Sidebar）

- 宽度：`220px`
- 背景：`--bg-sidebar`
- 分三层：顶部 New Chat 按钮、中间分组（Workspace / Recent）、底部用户信息
- 每个 item：高度 28–30px，圆角 8px
- Active item 用白底 + 0.5px 边框，**不用**强色背景

### 5.3 工具调用 inline 卡片（核心组件）

Agent 调用工具时在对话流中的展示。这是整个 UI 的灵魂。

**结构：**
```
┌─ Header (bg-sidebar, 8px 12px) ─────────────────┐
│ ● 🔧 tool_name · completed in 1.4s         ⌄    │
├─ Body (mono, 11px, 白底) ──────────────────────┤
│  param: "value"                                  │
│  param: 600                                      │
├─ Results (0.5px dashed top border) ────────────┤
│  result line 1                          £548    │
│  result line 2                          £572    │
└──────────────────────────────────────────────────┘
```

**三态：**
| 状态 | 左圆点 | 文字 | 边框 | 背景 |
|---|---|---|---|---|
| 完成 | `--accent-success` 绿 | 默认 | hairline | 白 |
| 运行中 | `--accent-warning` 驼（pulse 动画） | `--accent-warning-text` | `--avatar-bg` | `#FBF8F3` |
| 失败 | `--accent-danger` 红 | `--accent-danger-text` | `--accent-danger-border` | `--accent-danger-bg` |

**Pulse 动画：**
```css
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
```

### 5.4 任务面板（Task Panel）

Agent 执行长任务时右侧 280px 面板。

**结构：**
1. 顶部：Plan 进度条（3px 高，绿色填充）
2. 中部：步骤列表，每步含 marker（done/running/pending）+ title + sub
3. 底部：4 项 metrics 网格（Elapsed / Tokens / Tool calls / Files）

**Step marker 规范：**
- `done`：实心圆 `--accent-success` + 白色对勾
- `running`：浅驼底 + 驼色 1.5px 描边 + 内部小圆点 pulse
- `pending`：透明 + 灰色 1.5px 描边

### 5.5 按钮

```
btn-primary:   bg=--text-primary (#2C2C2A), color=#FFFFFF
btn-ghost:     bg=transparent, border=0.5px --border-strong, color=--text-primary
btn-chip:      bg=transparent, border=0.5px --border-hairline, color=--text-secondary, font=11px
btn-stop:      bg=#FFFFFF, border=0.5px --border-strong, color=--accent-danger-text
```

所有按钮：圆角 6–8px，hover 不加大幅变化（最多 bg 微调），active 加 `transform: scale(0.98)`。

### 5.6 Toggle 开关

- 尺寸：30×16px
- On：`--accent-success` 绿
- Off：`#D9D6CD` 浅灰
- 圆头：12×12px，留 2px 边距

### 5.7 状态 Pill

```css
.pill { font-size: 11px; padding: 2px 8px; border-radius: 6px; }
```

四种变体：`pill-success` / `pill-warning` / `pill-danger`（带 0.5px 描边） / `pill-neutral`。

### 5.8 输入框 / Composer

主对话区底部的输入框：

- 外框：0.5px `--border-strong`，圆角 12px
- 内部分两层：上方文字输入区，下方左右分布的操作按钮
- 左侧 chip 按钮：Attach / Tools · N / Context / @
- 右侧：⌘↵ 提示 + 26×26 黑色发送按钮（含上箭头）

---

## 6. 六个核心页面

### 6.1 主对话视图（Main Chat）

**布局**：`220px 侧栏 + 1fr 主区`

**关键元素：**
- 顶部对话标题 + 模型选择 pill（带绿点 + 模型名）
- 消息列表：用户消息（带头像）、Assistant 消息（带黑底 Sparkles 图标）
- 工具调用卡片直接嵌在 Assistant 消息体内
- 底部 composer

### 6.2 Agent 任务执行视图（Task Runner）

**布局**：`1fr 主对话 + 280px 任务面板`

切换条件：当用户启动一个长任务（多步 agent 执行）时，UI 自动从主对话视图切换到此布局。任务结束后可折叠回主视图。

**关键差异：**
- 主对话区顶部加一个"任务面包屑" + 红色 Stop 按钮
- 文件预览以 code card 形式嵌入对话流，带 `+N` 行数标签
- 右侧面板实时更新进度

### 6.3 工具市场页（Tools Marketplace）

**布局**：单页全宽，无侧栏（用主侧栏导航进入）

**结构：**
1. 顶部标题 + "Add custom" 主按钮
2. Tabs：All / Installed / Development / Productivity / Data / Travel + 右侧搜索框
3. 工具卡片 2 列网格：每张卡片含图标 + 名称 + 状态 pill + URL + 描述 + 右上 toggle/install

**工具卡片状态：**
- Active（已安装启用）：白底 + 绿色 Active pill + 开启的 toggle
- Auth needed：`--accent-danger-bg` 浅红底 + `--accent-danger-border` 描边 + Connect 按钮
- Available（未安装）：白底 + 灰色 Install 描边按钮

### 6.4 工具执行确认弹窗（HITL Modal）

Agent 调用敏感工具（shell、file write、网络请求等）时弹出。

**结构：**
1. Header：圆角小图标 + 工具名 + 副标题 + 关闭 X
2. Body：
   - 命令展示（终端样式：黑底浅米色字 + 绿色 `$` 提示符）
   - 两栏元信息：Working dir / Timeout
   - Warning 卡片：驼色底 + info-circle 图标 + 解释文字
   - 复选框："Auto-approve similar in this session"
3. Footer：Deny（ghost）+ Allow and run（primary，带对勾图标）

**背景遮罩**：`rgba(44, 44, 42, 0.35)`

### 6.5 设置页（Settings）

**布局**：`200px 左导航 + 1fr 右内容`

**导航项**：Account / Model / Tools / Permissions / Shortcuts / Appearance / Experiments / About

**Setting Row 通用模式**：
- 横向：label-block（标题 + 描述）+ 控件
- 每行 padding 16px 0，下方 0.5px hairline 分隔
- 控件类型：toggle / select-faux / slider / btn-ghost

**Model 页特殊**：
- 默认模型 select + 三个变体卡片（Opus 4.7 selected 状态用 1.5px 黑色描边）
- Auto-run trusted tools 行带 "Caution" 红色 pill

### 6.6 启动 / 欢迎页（Welcome）

**布局**：单页居中（max-width 540px）

**结构（从上到下）：**
1. 48×48 黑色圆角 Logo（含 Sparkles 图标）
2. "Good morning, Leon" 大标题 + 副标题
3. 大输入框（540×~120px，2 行内容）
4. 2×2 建议卡片：Code（绿）/ Write（驼）/ Research（蓝）/ Create（红）—— 每类用一种莫兰迪色点缀图标和标签
5. "Pick up where you left off" 最近会话列表（3 条，hairline 分隔）

---

## 7. shadcn 组件映射

| Atlas 区域 | shadcn 组件 |
|---|---|
| 主侧边栏 | `<Sidebar>` + `<SidebarMenu>` + `<SidebarMenuItem>` |
| 顶部对话工具栏 | 自定义 `<div>` + `<Button variant="ghost" size="icon">` |
| 用户头像 / Bot 头像 | `<Avatar>` + `<AvatarFallback>` |
| 工具调用卡片 | `<Collapsible>` + `<Card>` |
| 任务面板步骤 | 自定义 + `<Progress>` |
| 工具市场 tab | `<Tabs>` + `<TabsList>` + `<TabsTrigger>` |
| 工具卡片 | `<Card>` + `<Switch>` + `<Badge>` |
| HITL 弹窗 | `<Dialog>` + `<DialogContent>` + `<Alert variant="default">` |
| 设置项 toggle | `<Switch>` |
| 设置项 select | `<Select>` |
| 设置项 slider | `<Slider>` |
| Composer | 自定义 `<Textarea>` + `<Button>` 组合 |
| 状态 Pill | `<Badge>`（需自定义 variant） |
| 命令面板（潜在） | `<Command>` + `<CommandDialog>` |

### 7.1 shadcn 主题覆盖（globals.css 片段）

```css
@layer base {
  :root {
    --background: 60 9% 98%;          /* #FAFAF9 */
    --foreground: 60 4% 17%;          /* #2C2C2A */

    --card: 0 0% 100%;
    --card-foreground: 60 4% 17%;

    --popover: 0 0% 100%;
    --popover-foreground: 60 4% 17%;

    --primary: 60 4% 17%;             /* #2C2C2A */
    --primary-foreground: 60 9% 98%;

    --secondary: 45 14% 95%;          /* #F4F3F0 */
    --secondary-foreground: 60 4% 17%;

    --muted: 45 14% 95%;
    --muted-foreground: 45 5% 37%;    /* #5F5E5A */

    --accent: 45 14% 95%;
    --accent-foreground: 60 4% 17%;

    --destructive: 4 28% 57%;         /* #B8716C 莫兰迪红 */
    --destructive-foreground: 0 0% 100%;

    --border: 0 0% 0% / 0.08;
    --input: 0 0% 0% / 0.16;
    --ring: 60 4% 17%;

    --radius: 0.5rem;                 /* 8px = md */

    /* 自定义 agent 语义色 */
    --success: 100 13% 58%;           /* #8FA682 */
    --success-foreground: 100 16% 35%;
    --warning: 28 49% 60%;            /* #C99A6B */
    --warning-foreground: 28 32% 41%;
  }
}
```

---

## 8. 暗色模式（待扩展）

当前规范只覆盖浅色模式。未来若要加暗色：

- `--bg-app` → `#1A1917`
- `--bg-surface` → `#22211F`
- `--text-primary` → `#EDEAE3`
- 莫兰迪色保持不变，但 `*-bg` 改为对应深色版（如 `#2E342A` 代替 `#E8EDE4`）
- Hairline 边框：`rgba(255,255,255,0.08)`

---

## 9. 资源 / 实现备注

- **图标**：Tabler Icons (outline only)，通过 webfont 引入 `<i class="ti ti-NAME">`
- **字体**：系统字体栈，无需额外引入（macOS 上 SF，Windows 上 Segoe UI）
- **代码高亮**：建议用 [shiki](https://github.com/shikijs/shiki) 配 `vitesse-light` 主题，色调一致
- **动画**：仅用于状态过渡（toggle、pulse），不要装饰性动画
- **Electron 集成要点**：
  - 标题栏使用 `titleBarStyle: 'hiddenInset'`（macOS）让 traffic light 浮在 titlebar 上
  - Windows/Linux 需自绘 traffic light 或换成右上角原生按钮
  - 整窗圆角通过 `BrowserWindow` 的 `roundedCorners: true` + CSS `border-radius` 实现

---

## 10. 文件清单

| 文件 | 说明 |
|---|---|
| `atlas-ui-preview.html` | 完整 HTML 单文件预览，浏览器打开可看全部 6 个界面 |
| `atlas-ui-spec.md` | 本文件 |

**截图导出**：在浏览器中打开 HTML 预览后，用 `Cmd/Ctrl + Shift + S`（Chrome/Edge 截屏）或开发者工具的 **Capture full size screenshot** 功能可导出每个界面的高清 PNG。
