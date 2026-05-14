# Atlas · Auth 页面设计规范

> 登录 / 注册 / 忘记密码三个页面的设计说明
> 与主应用 UI 共享同一套 design tokens（见 `atlas-ui-spec.md`）

---

## 1. 设计目标

Auth 页面是用户接触产品的第一个界面，承担三个任务：

1. **传递信任** — 用桌面级窗口质感（traffic light + hairline border）告诉用户这是一款认真的产品
2. **降低摩擦** — SSO 优先 + 实时校验反馈，让"创建账户"在 30 秒内完成
3. **沿用主应用语言** — 同样的色彩、圆角、字号，让登录后过渡到主界面没有割裂感

**核心原则**：Auth 页面不引入任何主应用之外的视觉元素。所有 design tokens 都来自主应用的 `:root` 变量。

---

## 2. 三个页面对比

| 维度 | 登录 (Sign In) | 注册 (Sign Up) | 忘记密码 (Forgot) |
|---|---|---|---|
| 布局 | 双栏 1:1 | 双栏 1:1 | 单栏居中 |
| 最小高度 | 580px | 620px | 520px |
| 左侧内容 | 品牌叙事 + testimonial | 3 步引导 + 免费套餐 | 无 |
| SSO 按钮密度 | 大按钮（垂直堆叠，全文字） | 紧凑（横向 3 等分） | 无 |
| 表单字段 | Email + Password | Name + Email + Password | Email |
| 主 CTA | "Sign in" | "Create account" | "Send reset link" |
| 顶部右上链接 | "Create account" | "Sign in" | 无（用左上 back 链接） |
| 底部 footer | 完整（© + Privacy/Terms/Support） | 完整 | 仅 Privacy/Terms/Support |

**为什么登录和注册都是双栏？** 这两个页面是首次接触点，需要传递产品价值。忘记密码页面只服务于已注册用户的二次操作，简洁更重要。

---

## 3. 布局规范

### 3.1 双栏布局（登录 / 注册）

```
┌─ Window (with traffic light) ─────────────────────┐
│ ┌─────────────────┬─────────────────────────────┐ │
│ │  Brand panel    │  Form panel                  │ │
│ │  bg: #F4F3F0    │  bg: #FFFFFF                 │ │
│ │  padding: 40 36 │  padding: 56 44 36           │ │
│ │  flex: column   │  flex: column                │ │
│ │  space-between  │                              │ │
│ │                 │  ┌─ top right link ─┐         │ │
│ │  [Logo]         │  │ "New to Atlas?"  │         │ │
│ │                 │  └──────────────────┘         │ │
│ │  [Headline]     │                              │ │
│ │  [Sub copy]     │  ┌─ form (max-w 340) ─┐       │ │
│ │  [Features]     │  │ [Title]            │       │ │
│ │                 │  │ [Sub]              │       │ │
│ │  [Testimonial   │  │ [SSO buttons]      │       │ │
│ │   card]         │  │ [Divider]          │       │ │
│ │                 │  │ [Form fields]      │       │ │
│ │                 │  │ [Submit button]    │       │ │
│ │                 │  └────────────────────┘       │ │
│ │                 │                              │ │
│ │                 │  ┌─ footer ─┐                 │ │
│ │                 │  │ © 2026   │                 │ │
│ │                 │  └──────────┘                 │ │
│ └─────────────────┴─────────────────────────────┘ │
└───────────────────────────────────────────────────┘
```

**栅格规则：**
- 双栏比例：**1:1**（grid-template-columns: 1fr 1fr）
- 中间分隔线：0.5px `--border-hairline`
- 左侧 padding：40px 36px
- 右侧 padding：56px 44px 36px（顶部多 16px，给"New to Atlas"链接留位）
- 右侧表单容器：max-width 340px，居中

### 3.2 单栏布局（忘记密码）

```
┌─ Window ──────────────────────────────────────┐
│                                                │
│              [Atlas logo + name]               │  ← 48px margin-bottom
│                                                │
│  ┌─ form card (max-w 380) ──────────────────┐ │
│  │ ← Back to sign in                         │ │
│  │                                            │ │
│  │ [Key icon, 44×44]                          │ │
│  │                                            │ │
│  │ Reset your password                        │ │
│  │ Enter the email associated with...         │ │
│  │                                            │ │
│  │ [Email input]                              │ │
│  │ [Send reset link button]                   │ │
│  │                                            │ │
│  │ [Warning tip card]                         │ │
│  └────────────────────────────────────────────┘ │
│                                                │
│              [Privacy · Terms · Support]       │  ← margin-top: auto
└────────────────────────────────────────────────┘
```

- 容器：max-width 380px，居中
- 整页：flex column align center
- footer 用 `margin-top: auto` 推到底部

---

## 4. 关键组件

### 4.1 SSO 按钮

#### 大按钮变体（登录页）

```html
<button class="btn-ghost" style="padding: 10px 12px; justify-content: center;">
  [Logo SVG]
  Continue with Google
</button>
```

- 高度：~40px
- 圆角：8px（`--radius-md`）
- 边框：0.5px `--border-strong`（`rgba(0,0,0,0.16)`）
- 字号：13px
- Logo 尺寸：15×15px
- 排列：垂直堆叠，gap 8px

#### 紧凑变体（注册页）

```html
<button class="btn-ghost" style="padding: 9px 8px; justify-content: center; font-size: 12px;">
  [Logo SVG, 14×14]
  Google
</button>
```

- 高度：~34px
- 字号：12px
- Logo 尺寸：14×14px
- 排列：3 列等分（grid-template-columns: 1fr 1fr 1fr）

**为什么两种密度？** 登录页表单短，可以用大按钮强调；注册页表单长（4 个字段 + 强度反馈 + 条款），SSO 必须紧凑才不挤压主流程。

### 4.2 输入框（三种状态）

```css
/* Default: 0.5px 灰边 */
border: 0.5px solid var(--border-strong);
border-radius: var(--radius-md);
padding: 9px 12px;

/* Focused: 1px 黑边（突出 0.5px） */
border: 1px solid var(--text-primary);

/* Success (validated): 0.5px 绿边 + 右侧 ✓ */
border: 0.5px solid var(--accent-success);
/* 内部右侧加 <i class="ti ti-check"> 图标，颜色 --accent-success-text */
```

**结构**：左侧图标（14px, `--text-tertiary`）+ 输入文本（13px）+ 右侧操作图标（可选，如眼睛、check）

**Label**：
- 字号 11px，weight 500
- 颜色 `--text-secondary`
- margin-bottom 6px

### 4.3 密码强度反馈

```
[••••••••••••]        ← 密码输入框
[█████░░░░]            ← 4 段强度条（3/4 填充 = strong）
✓ 12+ chars  ✓ Number  ✓ Mixed case  ○ Symbol
```

**强度条规则：**
- 4 个独立 div，flex: 1，gap 4px，height 3px
- 已满足分段：填充 `--accent-success`
- 未满足分段：填充 `#EAE7E0` 浅灰
- 圆角 2px

**等级映射：**
| 满足数 | 视觉 | 文案 |
|---|---|---|
| 0 | 全灰 | (无显示) |
| 1 | 1/4 红 (`--accent-danger`) | "Weak" |
| 2 | 2/4 驼 (`--accent-warning`) | "Fair" |
| 3 | 3/4 绿 (`--accent-success`) | "Strong" |
| 4 | 4/4 绿 | "Excellent" |

**Check 项规则：**
- 满足：图标 `ti-check` + 颜色 `--accent-success-text`
- 未满足：图标 `ti-circle` + 颜色 `--text-tertiary`
- 4 项水平排列，flex-wrap 允许换行，gap 4px 12px

### 4.4 Checkbox

```html
<span style="width: 14px; height: 14px; border-radius: 3px;
             background: var(--text-primary);
             display: flex; align-items: center; justify-content: center;">
  <i class="ti ti-check" style="font-size: 10px; color: #FFFFFF;"></i>
</span>
```

**两种状态：**
- Checked：黑底白对勾
- Unchecked：透明底 + 1.5px `--border-strong` 边框（与设置页一致）

### 4.5 左侧 Feature 列表（登录页）

每个 feature 用一个 22×22 小圆 + 莫兰迪底色 + 12px 图标：

| Feature | 圆底色 | 图标色 | 图标 |
|---|---|---|---|
| Tools | `--accent-success-bg` | `--accent-success-text` | `ti-tools` |
| Security | `--accent-warning-bg` | `--accent-warning-text` | `ti-shield-check` |
| Local-first | `#EAEFF4` | `--accent-info` | `ti-folder` |

**关键**：每个 feature 用不同颜色，但都是莫兰迪低饱和，整体仍属于黑白灰系。

### 4.6 步骤引导（注册页）

```
①  Create your account               ← 当前步：实心黑底白字
   Email, Google, Apple, or GitHub.

②  Pick your tools                    ← 未来步：白底灰字 + 0.5px 边
   Connect GitHub, Notion, Slack...

③  Run your first task                ← 未来步
   From spec to working code...
```

**步骤标记规范：**
- 当前步：22×22 圆，`--text-primary` 底，`#FFFFFF` 字
- 未来步：22×22 圆，`#FFFFFF` 底，0.5px `--border-strong` 边，`--text-tertiary` 字
- 完成步（未在 mockup 中，但应支持）：实心 `--accent-success` 底 + 白色 check

### 4.7 Testimonial 卡片（登录页底部）

```css
background: #FFFFFF;
border: 0.5px solid var(--border-hairline);
border-radius: 10px;
padding: 14px 16px;
```

**结构**：引言（12.5px，line-height 1.6）+ 头像/姓名/职位行（gap 10px，头像 22×22）

### 4.8 警告提示卡（忘记密码页）

```css
padding: 12px 14px;
background: var(--accent-warning-bg);  /* #FBF1E2 */
border-radius: var(--radius-md);
display: flex; gap: 10px; align-items: flex-start;
```

含 `ti-info-circle` 图标（`--accent-warning-text`）+ 12px 解释文字（颜色 `#5C4731`，比 warning-text 略深）。

---

## 5. 文案规范

### 5.1 标题文案（左侧品牌区）

- 登录："Your AI agent, now on your desktop."
- 注册："Get started in under a minute."

**两个原则：**
1. **两行内**，单行不超过 24 字符
2. 用低承诺语气 — "now on your desktop" 比 "the best AI" 可信

### 5.2 CTA 按钮文案

| 场景 | 文案 | 后缀 |
|---|---|---|
| 登录主按钮 | Sign in | → 箭头 |
| 注册主按钮 | Create account | → 箭头 |
| 忘记密码 | Send reset link | 无 |
| SSO | Continue with [Google/Apple/GitHub] | logo 前缀 |

**禁用文案**：
- ❌ "Get started for free!"（过度营销）
- ❌ "Login"（用 Sign in 更地道）
- ❌ "Submit"（语义弱）

### 5.3 微文案

- "Keep me signed in on this device" — 比 "Remember me" 更明确
- "Forgot?" — 单字而非 "Forgot password?"（紧贴 Password label）
- "Free forever. Upgrade when you outgrow it." — 比 "Sign up for free" 更有承诺感

---

## 6. 状态与交互

### 6.1 表单校验

**校验时机：**
- 邮箱：失焦时校验格式，校验通过加绿色 check + 绿边
- 密码：键入时实时更新强度条和 check 项
- Name：可选项不强校验

**错误态（mockup 中未展示，但应支持）：**

```css
border: 1px solid var(--accent-danger);  /* 红边 1px，不是 0.5px */
/* 下方加错误文字 */
font-size: 11px;
color: var(--accent-danger-text);
margin-top: 4px;
```

错误图标用 `ti-alert-circle`。

### 6.2 加载态

主 CTA 按钮的加载态：
```html
<button class="btn-primary" disabled>
  <i class="ti ti-loader-2" style="animation: spin 0.8s linear infinite;"></i>
  Signing in...
</button>
```

```css
@keyframes spin { to { transform: rotate(360deg); } }
```

按钮禁用时：`opacity: 0.6; cursor: not-allowed;`

### 6.3 SSO OAuth 流程

桌面 Electron app 的 OAuth 推荐流程：
1. 用户点 "Continue with Google"
2. 弹出系统浏览器（不在 app 内 webview），跳转 Google OAuth
3. 回调到 `atlas://oauth/callback?code=...`（自定义协议）
4. Electron 主进程捕获 protocol 调用，完成 token 交换
5. 主窗口显示成功状态，跳转主应用

**为什么不用 in-app webview？** 主流 OAuth provider（Google、Apple）正在禁止 embedded webview 登录，且系统浏览器能复用已登录会话。

---

## 7. shadcn 组件映射

| Auth 元素 | shadcn 组件 | 备注 |
|---|---|---|
| 表单容器 | `<Form>` (react-hook-form 集成) | |
| 输入框 | `<Input>` | 自定义左右 icon slot |
| Label | `<Label>` | |
| SSO 按钮 | `<Button variant="outline">` | |
| 主 CTA | `<Button>` (default variant) | |
| Checkbox | `<Checkbox>` | |
| 密码强度条 | 自定义（4 个 `<div>`） | 或用 `<Progress>` × 4 |
| Check 项列表 | 自定义 | |
| 警告提示卡 | `<Alert>` | variant="default"，背景改为驼色 |
| 分隔线 | `<Separator>` | 加自定义文字标签 |
| Testimonial | `<Card>` | |

### 7.1 推荐目录结构

```
src/
├── app/
│   ├── (auth)/
│   │   ├── layout.tsx           # 套窗口框 + traffic light
│   │   ├── sign-in/
│   │   │   └── page.tsx
│   │   ├── sign-up/
│   │   │   └── page.tsx
│   │   └── forgot-password/
│   │       └── page.tsx
│   └── ...
├── components/
│   ├── auth/
│   │   ├── auth-layout.tsx      # 双栏布局复用
│   │   ├── sso-buttons.tsx      # 大按钮 + 紧凑两种 variant
│   │   ├── password-input.tsx   # 含强度反馈
│   │   ├── brand-panel.tsx      # 左侧品牌区
│   │   └── form-divider.tsx     # "or with email" 分隔线
│   └── ui/                       # shadcn 组件
```

### 7.2 表单校验（Zod 示例）

```typescript
import { z } from 'zod';

export const signInSchema = z.object({
  email: z.string().email('Please enter a valid email'),
  password: z.string().min(1, 'Password is required'),
  remember: z.boolean().default(true),
});

export const signUpSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Please enter a valid email'),
  password: z
    .string()
    .min(12, 'At least 12 characters')
    .regex(/[0-9]/, 'Must include a number')
    .regex(/[a-z]/, 'Must include lowercase')
    .regex(/[A-Z]/, 'Must include uppercase'),
  terms: z.literal(true, {
    errorMap: () => ({ message: 'You must accept the terms' }),
  }),
});

export type SignInValues = z.infer<typeof signInSchema>;
export type SignUpValues = z.infer<typeof signUpSchema>;
```

### 7.3 密码强度 hook

```typescript
export function usePasswordStrength(password: string) {
  const checks = {
    length: password.length >= 12,
    number: /[0-9]/.test(password),
    mixedCase: /[a-z]/.test(password) && /[A-Z]/.test(password),
    symbol: /[!@#$%^&*(),.?":{}|<>]/.test(password),
  };
  const score = Object.values(checks).filter(Boolean).length;

  return {
    checks,
    score,                                    // 0-4
    level: ['', 'weak', 'fair', 'strong', 'excellent'][score],
    color: ['', 'danger', 'warning', 'success', 'success'][score],
  };
}
```

---

## 8. Electron 集成要点

### 8.1 窗口尺寸

Auth 页面建议固定窗口尺寸，避免大屏拉伸破坏布局：

```typescript
// main.ts
const authWindow = new BrowserWindow({
  width: 880,
  height: 660,
  resizable: false,
  fullscreenable: false,
  titleBarStyle: 'hiddenInset',  // macOS：让 traffic light 浮在内容上
  trafficLightPosition: { x: 14, y: 14 },
  webPreferences: { /* ... */ },
});
```

登录成功后：
- 关闭 auth window
- 打开主应用 window（默认尺寸 1280×800，可 resize）

### 8.2 OAuth 自定义协议

```typescript
// 注册自定义协议
app.setAsDefaultProtocolClient('atlas');

// 监听回调
app.on('open-url', (event, url) => {
  // url: atlas://oauth/callback?code=...
  const code = new URL(url).searchParams.get('code');
  authWindow.webContents.send('oauth-callback', code);
});
```

### 8.3 安全凭据存储

**不要**：用 localStorage 存 access token（Electron 中等同于明文）

**要**：用 `keytar` 或 Electron `safeStorage`：

```typescript
import { safeStorage } from 'electron';

// 写入
const encrypted = safeStorage.encryptString(accessToken);
fs.writeFileSync(tokenPath, encrypted);

// 读取
const encrypted = fs.readFileSync(tokenPath);
const accessToken = safeStorage.decryptString(encrypted);
```

---

## 9. 可访问性（A11y）

- 所有输入框关联 `<label for>` 或包裹在 `<label>` 内
- SSO 按钮加 `aria-label="Continue with Google"`（图标按钮要明确）
- 密码可见性切换按钮加 `aria-label="Show password"` / `"Hide password"`
- 错误信息用 `role="alert"` + `aria-live="polite"`
- 主 CTA 在 loading 时设 `aria-busy="true"`
- Tab 顺序：SSO 按钮组 → 邮箱 → 密码 → 记住我 → 主 CTA → "Forgot?"

---

## 10. 文件清单（更新）

| 文件 | 说明 |
|---|---|
| `atlas-ui-preview.html` | **已更新**，现在包含 9 个界面（6 主应用 + 3 auth） |
| `atlas-ui-spec.md` | 主应用设计规范 |
| `atlas-auth-spec.md` | 本文件 · Auth 页面专用规范 |

直接在浏览器打开 `atlas-ui-preview.html`，向下滚动到 Screen 07-09 即可看到登录、注册、忘记密码三个完整界面。

**截图建议**：开发者工具的 device toolbar 设成 880×660（与 Electron auth window 实际尺寸一致），用 "Capture screenshot" 导出，得到的就是产品上线时的真实视觉。
