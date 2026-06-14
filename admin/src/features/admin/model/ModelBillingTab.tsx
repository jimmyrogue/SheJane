import Loader2 from 'lucide-react/dist/esm/icons/loader-2'
import { Button } from '@/components/ui/button'
import type { ModelConfigManager } from './types'

function BillingField({
  id,
  label,
  value,
  onChange,
  hint,
  suffix,
  mono = false,
  width,
  placeholder,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  hint?: string
  suffix?: string
  mono?: boolean
  width: number
  placeholder?: string
}) {
  return (
    <div className="block" style={{ width }}>
      <label htmlFor={id} className="admin-field-label">{label}</label>
      <div className="admin-field-box">
        <input
          id={id}
          value={value}
          placeholder={placeholder}
          className={mono ? 'admin-mono' : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
        {suffix ? <span className="admin-field-suffix">{suffix}</span> : null}
      </div>
      {hint ? <div className="admin-field-hint">{hint}</div> : null}
    </div>
  )
}

export function ModelBillingTab({ manager }: { manager: ModelConfigManager }) {
  return (
    <div className="flex flex-col gap-[18px]">
      <section className="admin-billing-card">
        <h3>计费参数</h3>
        <p className="admin-billing-desc">
          全局加价系数即产品固定利润（1.15 = 全线加价 15%，建议 1.10–1.20）。文本模型按每百万 token 的 CNY 成本价计费，乘以加价系数后，再按每百万 token 金额换算扣除。
        </p>
        <div className="admin-billing-fields">
          <BillingField
            id="markup-value"
            label="全局加价系数（利润）"
            value={manager.markupInput}
            onChange={manager.setMarkupInput}
            placeholder="1.15 = 加价 15%"
            hint="= 全线加价 15%"
            mono
            width={190}
          />
          <BillingField
            id="rate-value"
            label="每百万 token 金额"
            value={manager.rateInput}
            onChange={manager.setRateInput}
            placeholder="例如 20"
            hint="默认 20，保存后自动换算"
            suffix={`${manager.rateCurrency || 'cny'} / 1M`}
            mono
            width={230}
          />
          <BillingField
            id="rate-currency"
            label="货币"
            value={manager.rateCurrency}
            onChange={manager.setRateCurrency}
            width={120}
          />
          <Button className="mt-6 h-[38px]" onClick={() => void manager.saveRate()} disabled={manager.rateSaving}>
            {manager.rateSaving ? <Loader2 className="size-4 animate-spin" /> : null}
            保存
          </Button>
        </div>
      </section>

      <section className="admin-billing-card">
        <h3>工具计费杠杆</h3>
        <p className="admin-billing-desc">
          每次调用工具收取的 credits，保存后即时生效（本实例立即，其它实例 ≤30s 收敛）。留空或 0 表示沿用环境默认值。这些是 Reserve→Settle 的成本输入，不涉及钱包发放。
        </p>
        <div className="admin-billing-fields">
          <BillingField
            id="lever-tavily"
            label="web.search 每次"
            value={manager.tavilyInput}
            onChange={manager.setTavilyInput}
            placeholder="默认 20"
            suffix="credits"
            mono
            width={170}
          />
          <BillingField
            id="lever-e2b-base"
            label="code.execute 基础"
            value={manager.e2bBaseInput}
            onChange={manager.setE2bBaseInput}
            placeholder="默认 5"
            suffix="credits"
            mono
            width={170}
          />
          <BillingField
            id="lever-e2b-persec"
            label="code.execute 每秒"
            value={manager.e2bPerSecInput}
            onChange={manager.setE2bPerSecInput}
            placeholder="默认 1"
            suffix="credits"
            mono
            width={170}
          />
          <Button className="mt-6 h-[38px]" onClick={() => void manager.saveLevers()} disabled={manager.leversSaving}>
            {manager.leversSaving ? <Loader2 className="size-4 animate-spin" /> : null}
            保存
          </Button>
        </div>
      </section>
    </div>
  )
}
