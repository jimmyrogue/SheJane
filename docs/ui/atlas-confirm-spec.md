# Atlas · 确认框设计规范

> Confirm Dialog 组件的 5 种变体设计与实现说明
> 共享主应用 design tokens（见 `atlas-ui-spec.md`）

---

## 1. 为什么需要 5 种变体？

很多设计系统只做一种"通用"对话框，然后让开发者通过 props 凑出各种场景。这会导致三个问题：

1. **语义模糊**：用户分不清"保存修改"和"删除账户"哪个更严重
2. **风险传递不足**：所有对话框长得一样，红色按钮失去警示作用
3. **过度警告或警告不够**：高频低风险操作（如保存）被弄得很重；低频高风险操作（如注销）反而不够醒目

Atlas 的方案是 **5 种语义独立的变体**，每种对应一类心理状态。开发者只需问一个问题："这个操作是哪一类？"，UI 自动给到合适的视觉权重。

---

## 2. 5 种变体一览

| ID | 变体 | 图标 | 图标底色 | 主按钮 | 适用场景 |
|---|---|---|---|---|---|
| 01 | **Neutral** | `ti-info-circle` | `--bg-sidebar` (#F4F3F0) | 黑（默认） | 未保存提示、退出未完成任务、模型切换 |
| 02 | **Warning** | `ti-alert-triangle` | `--accent-warning-bg` (#FBF1E2) | 黑（默认） | 断开工具、清空会话、关闭未保存 spec |
| 03 | **Destructive** | `ti-trash` | `--accent-danger-bg` (#FBF0EF) | **红 `#8B3E3A`** | 删除对话、移除工具、永久删除文件 |
| 04 | **Success** | `ti-check` | `--accent-success-bg` (#E8EDE4) | 黑（默认） | 任务完成、连接成功、订阅生效 |
| 05 | **High-friction** | `ti-alert-octagon` | `--accent-danger-bg` | **红 + 图标** + 字符确认 | 注销账户、清空全部数据 |

---

## 3. 核心设计决策

### 3.1 图标永远在左上角，不居中

iOS 风格的 Alert 把图标放正中、巨大，桌面应用照搬会显得很重、抢焦点。Atlas 用 **32×32 圆角方块图标 + 标题正文左对齐**，更克制且让视觉中心落在文字上。

```
┌──────────────────────────────────┐
│  ┌──┐  Title (14px, weight 500)  │
│  │📦│  Description (12.5px,      │
│  └──┘  text-secondary, 1.55)     │
│                                   │
│                  [Cancel] [Submit]│
└──────────────────────────────────┘
```

### 3.2 只有 Destructive 主按钮用红色

**Warning ≠ Destructive。**

- Warning：「提醒一下，但你可能要做」（断开 GitHub → 还能重连）
- Destructive：「做了就回不来」（删除对话）

如果 Warning 也用红色，红色就贬值了——下次真正的删除按钮反而失去警示作用。**红色是稀缺资源，留给真正不可逆的操作。**

| 操作 | 变体 | 主按钮色 |
|---|---|---|
| 断开 OAuth 连接 | Warning | 黑 |
| 重置 API key | Warning | 黑 |
| 删除单个对话 | Destructive | 红 |
| 永久删除项目所有文件 | Destructive | 红 |
| 注销账户 | High-friction | 红 + 字符确认 |

### 3.3 按钮排列：取消左、确认右

符合 macOS HIG。Windows 习惯相反，但桌面 AI 工具用户多在 macOS 上，**统一用 macOS 风格而不做平台分支**——平台分支会让产品身份模糊。

主按钮永远是右边、加粗（weight 500），次要按钮是左边的 ghost。

### 3.4 动词具体化

| ❌ 避免 | ✅ 使用 |
|---|---|
| OK / Confirm / Yes | Delete / Disconnect / Save / Done |
| Cancel（语义弱时） | Keep / Discard / Don't save |

按钮文案 = 用户接下来要发生什么。空泛的 "Confirm" 让用户犹豫一秒，具体的 "Disconnect" 让用户立刻判断。

### 3.5 不可逆操作必须明示

Destructive 和 High-friction 变体的正文里**必须**有一句明确的不可逆声明：

- ✅ "This action cannot be undone."
- ✅ "This cannot be undone."（更短）
- ❌ "Are you sure?"（无信息量）

---

## 4. 组件结构与尺寸

### 4.1 通用骨架

```
modal-backdrop:  rgba(44, 44, 42, 0.35)
modal:
  width:         380px (普通) / 440px (high-friction)
  background:    #FFFFFF
  border:        0.5px solid --border-strong
  border-radius: 12px (--radius-lg)
  box-shadow:    0 12px 36px -12px rgba(0, 0, 0, 0.2)
                 (high-friction: 0 16px 48px -12px rgba(0, 0, 0, 0.25))
```

### 4.2 内部布局

| 部位 | 内边距 | 备注 |
|---|---|---|
| 头部 (icon + text) | `20px 22px 0` | high-friction 用 `22px 24px 0` |
| 头部到按钮间距 | `margin-top: 12px` | high-friction `18px` + `border-top: 0.5px` |
| 底部 (按钮区) | `16px 22px 18px` | high-friction `18px 24px 20px` |
| Icon ↔ Text gap | `12px` | |
| Title ↔ Desc gap | `4px` (普通) / `6px` (high-friction) | |
| 按钮间 gap | `8px` | |

### 4.3 字体规范

| 元素 | size | weight | color | line-height |
|---|---|---|---|---|
| Title | 14px (普通) / 15px (high-friction) | 500 | `--text-primary` | 1.4, `letter-spacing: -0.1px` |
| Description | 12.5px | 400 | `--text-secondary` | 1.55–1.6 |
| 描述中的强调名词 | 12.5px | 500 | `--text-primary` | — |
| Mono 标记 (文件名) | 11.5px | 400 | `--text-primary` | bg: `--bg-sidebar`, padding `1px 5px`, radius `4px` |
| 按钮 | 12.5px | 400 (取消) / 500 (主) | — | — |

### 4.4 图标方块

所有变体共享相同尺寸，只换底色和图标：

```css
width: 32px;
height: 32px;
border-radius: 8px;   /* --radius-md */
display: flex;
align-items: center;
justify-content: center;
flex-shrink: 0;       /* 文字过长时不被压缩 */
```

图标本身 `font-size: 18px`，颜色用对应的 `text` token。

---

## 5. 变体详细规格

### 5.1 Neutral

**视觉**：灰底信息图标，整个对话框最"低调"的变体。

```css
.icon-box     { background: var(--bg-sidebar); }
.icon         { color: var(--text-primary); ti-info-circle }
.btn-primary  { background: var(--text-primary); color: #FFFFFF; }
```

**典型文案**：
- "Save changes to spec?" / "Save" + "Discard"
- "Switch to Sonnet 4.6?" / "Switch" + "Cancel"
- "Leave this task?" / "Leave" + "Stay"

### 5.2 Warning

**视觉**：驼色底 + 三角警示图标。

```css
.icon-box     { background: var(--accent-warning-bg); }   /* #FBF1E2 */
.icon         { color: var(--accent-warning-text); ti-alert-triangle }   /* #8B6A47 */
.btn-primary  { background: var(--text-primary); }   /* 仍是黑！ */
```

**典型文案**：
- "Disconnect GitHub?" / "Disconnect" + "Cancel"
- "Stop the running agent?" / "Stop" + "Continue running"
- "Replace existing file?" / "Replace" + "Cancel"

### 5.3 Destructive

**视觉**：红底垃圾桶 + **红色主按钮**。

```css
.icon-box     { background: var(--accent-danger-bg); }   /* #FBF0EF */
.icon         { color: var(--accent-danger-text); ti-trash }   /* #8B3E3A */
.btn-destructive {
  background: var(--accent-danger-text);   /* #8B3E3A */
  color: #FFFFFF;
}
```

**典型文案**：
- "Delete this conversation?" / "Delete" + "Cancel"
- "Remove this tool?" / "Remove" + "Cancel"

**正文必须含具体数据**：
- ✅ "**Flight deal alert spec** and all 47 messages will be permanently deleted."
- ❌ "Are you sure you want to delete?"

### 5.4 Success

**视觉**：绿底对勾。**不是真正的"确认"对话框，而是"任务完成"的礼貌通知**——但布局规格完全相同，因此归入同一组件。

```css
.icon-box     { background: var(--accent-success-bg); }   /* #E8EDE4 */
.icon         { color: var(--accent-success-text); ti-check }   /* #4F6342 */
.btn-primary  { background: var(--text-primary); }
```

**典型用法**：
- 主按钮 "Done" 关闭对话框
- 次要按钮 "View diff" / "Open file" 跳转到结果

**注意**：Success 不该有"危险"的取消按钮（如 "Discard results"）——任务已经完成了，没什么可"取消"的。

### 5.5 High-friction Destructive

**视觉**：红底八角警示图标 + 完整的三层防御。

```
┌────────────────────────────────────────┐
│  ⚠️  Delete your account?               │
│      This will permanently delete...    │
│                                         │
│  ┌─ What will be deleted ────────────┐  │
│  │ ✕ 23 conversations and 142 msgs   │  │  ← 红底卡片列举
│  │ ✕ 12 connected tools              │  │
│  │ ✕ Your subscription (Pro plan)    │  │
│  └───────────────────────────────────┘  │
│                                         │
│  Type [delete my account] to confirm   │  ← 字符串确认输入
│  [delete my account                ✓]   │
│                                         │
│  ───────────────────────────────────   │  ← 0.5px hairline 分隔底部
│           [Keep account] [🗑 Permanently delete]│
└────────────────────────────────────────┘
```

**三层防御缺一不可：**

1. **后果清单**（红底卡片，列具体数字）
   - 必须有数字（"23 conversations" 而非 "all your data"）
   - 用 `ti-x` 图标，配 `#5C2D2A` 文字色（比 `--accent-danger-text` 略深）
   - 卡片自身 `border: 0.5px solid --accent-danger-border`

2. **字符串输入确认**
   - 短语必须包含动词（"delete my account" 而非 "DELETE"）
   - 大小写敏感与否：建议**不敏感**（reduce frustration），但 trim 空格
   - 输入正确后右侧显示 `ti-check` 绿色对勾，主按钮才启用

3. **按钮强化**
   - 主按钮宽（`padding: 8px 14px`）、带 `ti-trash` 图标 + 完整文案 "Permanently delete"
   - 取消按钮文案改为 "Keep account"（更具体、更安抚）
   - 底部加 0.5px hairline 分隔，进一步降低误触

---

## 6. 状态与交互

### 6.1 进入与退出动画

```css
.modal-backdrop {
  animation: fade-in 0.15s ease-out;
}
.modal {
  animation: scale-in 0.18s cubic-bezier(0.16, 1, 0.3, 1);
  transform-origin: center;
}

@keyframes fade-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}

@keyframes scale-in {
  from { opacity: 0; transform: scale(0.96); }
  to   { opacity: 1; transform: scale(1); }
}
```

**不要**用 spring 弹性或大幅滑入——桌面应用要求克制。

### 6.2 主按钮加载态

提交后按钮变 loading：

```html
<button class="btn-primary" disabled>
  <i class="ti ti-loader-2 spinning"></i>
  Deleting…
</button>
```

```css
.spinning { animation: spin 0.8s linear infinite; }
button[disabled] { opacity: 0.6; cursor: not-allowed; }
```

文案从动词原型变为现在进行时："Delete" → "Deleting…"。

### 6.3 焦点管理

打开对话框时：
- **Neutral / Warning / Success**：焦点放在**主按钮**（用户大概率要确认）
- **Destructive**：焦点放在**取消按钮**（防止 Enter 误删）
- **High-friction**：焦点放在**输入框**

按 Esc 永远等同于点击 Cancel。

### 6.4 键盘

- `Esc` → Cancel
- `Enter` → 主按钮（**Destructive 例外：禁用 Enter 提交**，必须点击）
- `Tab` 在按钮之间循环

### 6.5 移动端响应（如果需要）

如果应用未来出 mobile 版本：
- 对话框 `max-width: calc(100vw - 32px)`
- 按钮全宽，垂直堆叠（主按钮在上）
- 高度内容超出时滚动，但按钮区固定在底部

---

## 7. 文案模板

### 7.1 Neutral（保存类）

| 场景 | Title | Description | Cancel | Primary |
|---|---|---|---|---|
| 未保存退出 | Save changes to <name>? | You've made edits to <name>. Save them before closing? | Discard | Save |
| 切换模型 | Switch to <model>? | Your current settings will apply to the new model. | Cancel | Switch |
| 离开任务 | Leave this task? | The agent is still running. You can come back anytime. | Stay | Leave |

### 7.2 Warning

| 场景 | Title | Description | Cancel | Primary |
|---|---|---|---|---|
| 断开工具 | Disconnect <tool>? | Running agents using <tool> will fail. You can reconnect anytime from Tools settings. | Cancel | Disconnect |
| 停止任务 | Stop the running agent? | <N> steps will be discarded. Files already written will remain. | Continue running | Stop |
| 覆盖文件 | Replace existing <file>? | The current contents will be overwritten with new code. | Cancel | Replace |

### 7.3 Destructive

| 场景 | Title | Description | Cancel | Primary (red) |
|---|---|---|---|---|
| 删除对话 | Delete this conversation? | **<name>** and all <N> messages will be permanently deleted. This action cannot be undone. | Cancel | Delete |
| 移除工具 | Remove <tool>? | The connection will be revoked and OAuth tokens deleted. This cannot be undone. | Cancel | Remove |
| 删除项目 | Delete project <name>? | All <N> files, conversations and history in this project will be permanently deleted. | Cancel | Delete project |

### 7.4 Success

| 场景 | Title | Description | Secondary | Primary |
|---|---|---|---|---|
| 任务完成 | Task completed | Agent finished **<task>** in <time>. Created <N> files, ran <N> tool calls. | View diff | Done |
| 工具连接 | <tool> connected | You can now use <tool> in any conversation. | View tools | Done |
| 订阅生效 | You're on the Pro plan | Unlimited agent runs and 50+ connected tools are now available. | View features | Get started |

### 7.5 High-friction

| 场景 | Title | Confirm string | Cancel | Primary (red + icon) |
|---|---|---|---|---|
| 注销账户 | Delete your account? | `delete my account` | Keep account | 🗑 Permanently delete |
| 清空全部数据 | Clear all data? | `clear everything` | Keep my data | 🗑 Clear all data |
| 取消订阅（年付提前退） | Cancel and refund? | `cancel my subscription` | Keep subscription | 🗑 Cancel and refund |

---

## 8. 使用决策树

```
用户操作触发了一个需要确认的动作？
│
├─ 是不可逆 + 影响范围大（账户、全部数据）？
│   → 用 High-friction
│
├─ 是不可逆 + 单个对象（一条会话、一个工具）？
│   → 用 Destructive（红主按钮）
│
├─ 是可逆 + 但有副作用（断开、覆盖、中断）？
│   → 用 Warning（驼色图标，黑主按钮）
│
├─ 不是确认，是任务完成的礼貌通知？
│   → 用 Success
│
└─ 其他（保存、切换、离开等中性提示）？
    → 用 Neutral
```

**避坑：**
- 不要在简单的"保存草稿"用 Warning（用户每天保存十几次，警告疲劳）
- 不要在"删除一条草稿消息"用 Destructive 红按钮（高频低风险，Warning 即可）
- 不要在"任务完成"用 Neutral（错失视觉确认的机会）

---

## 9. shadcn 实现映射

```tsx
import { AlertDialog, AlertDialogAction, AlertDialogCancel,
         AlertDialogContent, AlertDialogDescription,
         AlertDialogFooter, AlertDialogHeader,
         AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
```

### 9.1 ConfirmDialog API 设计

```tsx
type ConfirmVariant = 'neutral' | 'warning' | 'destructive' | 'success' | 'high-friction';

interface ConfirmDialogProps {
  variant: ConfirmVariant;
  open: boolean;
  onOpenChange: (open: boolean) => void;

  title: string;
  description: React.ReactNode;     // 支持 ReactNode 是为了内嵌 <code> 和 <strong>

  cancelLabel?: string;             // 默认 "Cancel"
  confirmLabel: string;             // 强制提供，避免 "OK"
  confirmIcon?: React.ReactNode;    // high-friction 时用

  onConfirm: () => void | Promise<void>;
  loading?: boolean;                // 外部控制 loading 态

  // High-friction 专用
  confirmPhrase?: string;           // e.g. "delete my account"
  consequences?: string[];          // 后果列表

  // 行为
  closeOnEsc?: boolean;             // 默认 true
  disableEnterToConfirm?: boolean;  // destructive 时建议 true
}
```

### 9.2 变体映射 hook

```tsx
function useConfirmVariantStyles(variant: ConfirmVariant) {
  switch (variant) {
    case 'neutral':
      return {
        iconBg: 'bg-[--bg-sidebar]',
        iconColor: 'text-[--text-primary]',
        IconComponent: InfoCircle,
        confirmButtonVariant: 'default',  // shadcn default = 黑
      };
    case 'warning':
      return {
        iconBg: 'bg-[--accent-warning-bg]',
        iconColor: 'text-[--accent-warning-text]',
        IconComponent: AlertTriangle,
        confirmButtonVariant: 'default',
      };
    case 'destructive':
      return {
        iconBg: 'bg-[--accent-danger-bg]',
        iconColor: 'text-[--accent-danger-text]',
        IconComponent: Trash,
        confirmButtonVariant: 'destructive',  // shadcn destructive
      };
    case 'success':
      return {
        iconBg: 'bg-[--accent-success-bg]',
        iconColor: 'text-[--accent-success-text]',
        IconComponent: Check,
        confirmButtonVariant: 'default',
      };
    case 'high-friction':
      return {
        iconBg: 'bg-[--accent-danger-bg]',
        iconColor: 'text-[--accent-danger-text]',
        IconComponent: AlertOctagon,
        confirmButtonVariant: 'destructive',
      };
  }
}
```

### 9.3 命令式 API（推荐）

为了避免在每个组件里都管理 `open` state，建议封装一个命令式 API：

```tsx
// 使用
import { confirm } from '@/lib/confirm';

const ok = await confirm({
  variant: 'destructive',
  title: 'Delete this conversation?',
  description: <><strong>Flight deal alert spec</strong> and all 47 messages will be permanently deleted. This action cannot be undone.</>,
  confirmLabel: 'Delete',
});

if (ok) {
  await deleteConversation(id);
}
```

实现思路：

```tsx
// lib/confirm.tsx
import { createRoot } from 'react-dom/client';

let confirmRoot: ReturnType<typeof createRoot> | null = null;

export function confirm(props: Omit<ConfirmDialogProps, 'open' | 'onOpenChange' | 'onConfirm'>): Promise<boolean> {
  return new Promise((resolve) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    confirmRoot = createRoot(container);

    const handleClose = (result: boolean) => {
      confirmRoot?.unmount();
      container.remove();
      resolve(result);
    };

    confirmRoot.render(
      <ConfirmDialog
        {...props}
        open={true}
        onOpenChange={(open) => !open && handleClose(false)}
        onConfirm={() => handleClose(true)}
      />
    );
  });
}
```

### 9.4 Tailwind 配置补充

```js
// tailwind.config.ts
module.exports = {
  theme: {
    extend: {
      colors: {
        'atlas-warning': {
          bg: '#FBF1E2',
          text: '#8B6A47',
        },
        'atlas-danger': {
          bg: '#FBF0EF',
          border: '#E3A8A4',
          text: '#8B3E3A',
        },
        'atlas-success': {
          bg: '#E8EDE4',
          text: '#4F6342',
        },
      },
    },
  },
};
```

---

## 10. A11y 清单

- [ ] 对话框根元素 `role="alertdialog"` (Destructive / High-friction) 或 `role="dialog"` (其他)
- [ ] `aria-labelledby` 指向 Title 元素的 id
- [ ] `aria-describedby` 指向 Description 元素的 id
- [ ] 打开时焦点自动到主按钮（或取消按钮 / 输入框，按变体）
- [ ] 焦点陷阱（Focus trap）：Tab 在对话框内循环
- [ ] 关闭后焦点返回触发元素
- [ ] Esc 关闭
- [ ] 加载态主按钮 `aria-busy="true"`
- [ ] High-friction 输入框关联 `<label for>` 或包裹在 `<label>`
- [ ] 屏幕阅读器对 Title 用 `assertive` 优先级，对 Description 用 `polite`

---

## 11. 测试用例（建议）

| 场景 | 期待行为 |
|---|---|
| 点击 backdrop | 关闭对话框（Destructive / High-friction 不关闭） |
| 按 Esc | 关闭对话框（所有变体） |
| 按 Enter | 触发主按钮（Destructive 不响应） |
| 主按钮 loading 时再点 | 不响应（按钮 disabled） |
| High-friction 输入错字符 | 主按钮保持 disabled |
| High-friction 输入正确字符 | 主按钮启用，右侧显示绿对勾 |
| 主按钮的 onConfirm 抛错 | 显示 toast，对话框保持打开 |
| 已 unmount 时 confirm() 还在 pending | resolve(false)，不报错 |

---

## 12. 文件清单（更新）

| 文件 | 说明 |
|---|---|
| `atlas-ui-preview.html` | **已更新**，现在包含 11 个界面（6 主应用 + 3 auth + 2 confirm） |
| `atlas-ui-spec.md` | 主应用设计规范 |
| `atlas-auth-spec.md` | Auth 页面规范 |
| `atlas-confirm-spec.md` | 本文件 · 确认框规范 |

向下滚动到 Screen 10-11 即可看到所有 5 个确认框变体。

---

## 13. 引用顺序约定

如果三份 spec 一起给到 AI 编码工具（Claude Code / Codex），建议引用顺序：

```
1. atlas-ui-spec.md         ← design tokens 在这里定义
2. atlas-auth-spec.md       ← 引用 1 中的 tokens
3. atlas-confirm-spec.md    ← 引用 1 中的 tokens
```

`atlas-confirm-spec.md` 中所有 CSS 变量都假设已经在 `globals.css` 里通过 `atlas-ui-spec.md` 第 7.1 节的代码注入。
