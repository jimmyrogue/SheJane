// Central display maps: backend codes → 中文. Every helper falls back to the
// raw value when a code isn't mapped, so an unknown code is shown as-is rather
// than hidden. These only affect display; the underlying data is untouched.

const STATUS: Record<string, string> = {
  active: '在线', online: '在线', inactive: '未激活', disabled: '已禁用',
  done: '完成', completed: '完成', succeeded: '成功', success: '成功',
  processing: '处理中', running: '运行中', queued: '排队中', pending: '待处理',
  failed: '失败', error: '异常', canceled: '已取消', cancelled: '已取消',
  paid: '已支付', unpaid: '未支付', past_due: '逾期', refunded: '已退款',
  expired: '已过期', incomplete: '未完成', trialing: '试用中',
  reserved: '已预扣', settled: '已结算', released: '已释放',
}

const AUDIT_ACTION: Record<string, string> = {
  login: '登录', logout: '登出',
  user_create: '创建用户', user_update: '更新用户', user_status_update: '更新用户状态',
  credit_adjust: '调整额度', credits_adjust: '调整额度',
  model_config_create: '新增模型配置', model_config_update: '更新模型配置',
  model_config_delete: '删除模型配置', model_config_toggle: '启停模型配置',
  credit_rate_update: '更新计费参数', rate_update: '更新计费参数',
  billing_levers_update: '更新工具计费',
}

const TARGET_TYPE: Record<string, string> = {
  model_config: '模型配置', user: '用户', wallet: '钱包', order: '订单',
  credit_rate: '计费参数', billing_levers: '工具计费', subscription: '订阅',
}

const ORIGIN: Record<string, string> = {
  cloud: '云端', local: '本地', desktop: '桌面端', web: '网页端',
}

const RUN_MODE: Record<string, string> = {
  auto: '自动', 'auto.fast': '自动 · 快速', 'auto.smart': '自动 · 智能',
  fast: '快速', smart: '智能', deep: '深度', 'chat.fast': '快速对话', 'chat.deep': '深度对话',
}

const ROLE: Record<string, string> = {
  admin: '管理员', user: '普通用户', owner: '所有者', member: '成员',
}

const TX_TYPE: Record<string, string> = {
  usage_reserve: '额度预扣', usage_settle: '用量结算', usage_release: '额度释放',
  topup: '充值', topup_grant: '充值发放', subscription_grant: '订阅发放',
  monthly_grant: '月度发放', signup_grant: '注册赠送', trial_grant: '试用赠送',
  refund: '退款', recharge_refund: '充值退款', admin_adjust: '管理员调整', admin_credit_adjust: '管理员调整',
}

export function statusLabel(value: string): string {
  return STATUS[value] ?? value
}

export function auditActionLabel(value: string): string {
  const key = value.replace(/^admin\./, '').replace(/\./g, '_')
  return AUDIT_ACTION[key] ?? value
}

export function targetTypeLabel(value: string): string {
  return TARGET_TYPE[value] ?? value
}

export function originLabel(value: string): string {
  return ORIGIN[value] ?? value
}

export function runModeLabel(value: string): string {
  return RUN_MODE[value] ?? value
}

export function actorLabel(value?: string | null): string {
  return value && value !== 'system' ? value : '系统'
}

export function roleLabel(value: string): string {
  return ROLE[value] ?? value
}

export function txTypeLabel(value: string): string {
  return TX_TYPE[value] ?? value
}
