import Loader2 from 'lucide-react/dist/esm/icons/loader-2'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { ModelConfigManager } from './types'

export function ModelBillingTab({ manager }: { manager: ModelConfigManager }) {
  return (
    <div className="grid gap-4">
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>计费参数</CardTitle>
          <CardDescription>
            全局加价系数 = 产品固定利润（1.15 = 全线加价 15%，建议 1.10–1.20）。最终扣费 = 输入 tokens × 输入费率 + 输出 tokens × 输出费率，再乘加价系数。
            基准每 token 成本仅用于把生图等「按次金额」模型换算成 credits（每次金额 ÷ 基准成本 × 加价系数）。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="markup-value">全局加价系数（利润）</Label>
              <Input
                id="markup-value"
                value={manager.markupInput}
                onChange={(event) => manager.setMarkupInput(event.target.value)}
                placeholder="1.15 = 加价 15%"
                className="w-40"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rate-value">基准每 token 成本（{manager.rateCurrency || 'cny'}）</Label>
              <Input
                id="rate-value"
                value={manager.rateInput}
                onChange={(event) => manager.setRateInput(event.target.value)}
                placeholder="DeepSeek-Pro 每 token 成本，仅生图换算用；留空=不启用生图"
                className="w-72"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rate-currency">货币</Label>
              <Input
                id="rate-currency"
                value={manager.rateCurrency}
                onChange={(event) => manager.setRateCurrency(event.target.value)}
                className="w-24"
              />
            </div>
            <Button onClick={() => void manager.saveRate()} disabled={manager.rateSaving}>
              {manager.rateSaving ? <Loader2 className="size-4 animate-spin" /> : null}
              保存
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>工具计费杠杆</CardTitle>
          <CardDescription>
            每次调用工具收取的 credits，保存后即时生效（本实例立即，其它实例 ≤30s 收敛）。留空或 0 表示沿用环境默认值。
            这些是 Reserve→Settle 的成本输入，不涉及钱包发放。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="lever-tavily">web.search 每次</Label>
              <Input
                id="lever-tavily"
                value={manager.tavilyInput}
                onChange={(event) => manager.setTavilyInput(event.target.value)}
                placeholder="默认 20"
                className="w-32"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="lever-e2b-base">code.execute 基础</Label>
              <Input
                id="lever-e2b-base"
                value={manager.e2bBaseInput}
                onChange={(event) => manager.setE2bBaseInput(event.target.value)}
                placeholder="默认 5"
                className="w-32"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="lever-e2b-persec">code.execute 每秒</Label>
              <Input
                id="lever-e2b-persec"
                value={manager.e2bPerSecInput}
                onChange={(event) => manager.setE2bPerSecInput(event.target.value)}
                placeholder="默认 1"
                className="w-32"
              />
            </div>
            <Button onClick={() => void manager.saveLevers()} disabled={manager.leversSaving}>
              {manager.leversSaving ? <Loader2 className="size-4 animate-spin" /> : null}
              保存
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
