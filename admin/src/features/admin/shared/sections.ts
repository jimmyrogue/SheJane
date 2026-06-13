import type { ComponentType, SVGProps } from 'react'
import BarChart3 from 'lucide-react/dist/esm/icons/bar-chart-3'
import Bot from 'lucide-react/dist/esm/icons/bot'
import ClipboardList from 'lucide-react/dist/esm/icons/clipboard-list'
import ReceiptText from 'lucide-react/dist/esm/icons/receipt-text'
import Search from 'lucide-react/dist/esm/icons/search'
import Settings from 'lucide-react/dist/esm/icons/settings'
import Users from 'lucide-react/dist/esm/icons/users'

export type AdminSection = 'overview' | 'users' | 'tool-calls' | 'orders' | 'providers' | 'agent-runs' | 'audit'

export type AdminIcon = ComponentType<SVGProps<SVGSVGElement>>

export const PAGE_SIZE = 20

export const NAV_ITEMS: Array<{ id: AdminSection; label: string; icon: AdminIcon; description: string }> = [
  { id: 'overview', label: '概览', icon: BarChart3, description: '用户、额度、订单与模型状态的聚合视图。' },
  { id: 'users', label: '用户', icon: Users, description: '搜索用户，查看钱包、用量与管理操作。' },
  { id: 'tool-calls', label: '工具', icon: Search, description: '第三方工具调用记录，只读展示扣费与状态。' },
  { id: 'orders', label: '订单', icon: ReceiptText, description: '订阅与订单只读视图，不提供手工改状态入口。' },
  { id: 'providers', label: '模型', icon: Settings, description: '动态管理用户端模型目录、上游连接与 token 费率。' },
  { id: 'agent-runs', label: 'Agent', icon: Bot, description: '只读观察云端兼容 run 的状态、用户、模式与摘要。' },
  { id: 'audit', label: '审计', icon: ClipboardList, description: '只读展示后台操作与关键账务事件。' },
]

export function isAdminSection(value: string): value is AdminSection {
  return NAV_ITEMS.some((item) => item.id === value)
}
