import { useEffect, useState } from 'react'
import {
  type AdminAPI,
  type AdminAgentRun,
  type AdminAgentRunTrace,
  type AdminAuditLog,
  type AdminBillingLevers,
  type AdminCreditRate,
  type AdminModelConfig,
  type AdminOrder,
  type AdminOverview,
  type AdminToolCall,
  type AdminUserDetail,
  type AdminUserSummary,
} from '@/shared/api/client'
import { type AdminSection, isAdminSection, PAGE_SIZE } from '../shared/sections'

export function useAdminDashboardData(api: AdminAPI) {
  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [users, setUsers] = useState<AdminUserSummary[]>([])
  const [page, setPage] = useState(0)
  const [hasMoreUsers, setHasMoreUsers] = useState(false)
  const [toolCalls, setToolCalls] = useState<AdminToolCall[]>([])
  const [toolPage, setToolPage] = useState(0)
  const [hasMoreTool, setHasMoreTool] = useState(false)
  const [orders, setOrders] = useState<AdminOrder[]>([])
  const [orderPage, setOrderPage] = useState(0)
  const [hasMoreOrders, setHasMoreOrders] = useState(false)
  const [modelConfigs, setModelConfigs] = useState<AdminModelConfig[]>([])
  const [creditRate, setCreditRate] = useState<AdminCreditRate | null>(null)
  const [billingLevers, setBillingLevers] = useState<AdminBillingLevers | null>(null)
  const [agentRuns, setAgentRuns] = useState<AdminAgentRun[]>([])
  const [auditLogs, setAuditLogs] = useState<AdminAuditLog[]>([])
  const [auditPage, setAuditPage] = useState(0)
  const [hasMoreAudit, setHasMoreAudit] = useState(false)
  const [selectedUser, setSelectedUser] = useState<AdminUserDetail | null>(null)
  const [agentTrace, setAgentTrace] = useState<AdminAgentRunTrace | null>(null)
  const [traceLoadingId, setTraceLoadingId] = useState('')
  const [query, setQuery] = useState('')
  const [delta, setDelta] = useState('')
  const [reason, setReason] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(false)
  const [activeSection, setActiveSection] = useState<AdminSection>('overview')
  const [modelCreateRequest, setModelCreateRequest] = useState(0)

  useEffect(() => {
    void loadAdminData()
  }, [])

  async function loadUsersPage(nextQuery: string, nextPage: number) {
    const userData = await api.adminUsers(nextQuery, PAGE_SIZE, nextPage * PAGE_SIZE)
    setUsers(userData)
    setPage(nextPage)
    setHasMoreUsers(userData.length === PAGE_SIZE)
  }

  async function loadToolCallsPage(nextPage: number) {
    const data = await api.adminToolCalls(PAGE_SIZE, nextPage * PAGE_SIZE)
    setToolCalls(data)
    setToolPage(nextPage)
    setHasMoreTool(data.length === PAGE_SIZE)
  }

  async function loadOrdersPage(nextPage: number) {
    const data = await api.adminOrders(PAGE_SIZE, nextPage * PAGE_SIZE)
    setOrders(data)
    setOrderPage(nextPage)
    setHasMoreOrders(data.length === PAGE_SIZE)
  }

  async function loadAuditPage(nextPage: number) {
    const data = await api.adminAuditLogs(PAGE_SIZE, nextPage * PAGE_SIZE)
    setAuditLogs(data)
    setAuditPage(nextPage)
    setHasMoreAudit(data.length === PAGE_SIZE)
  }

  async function reloadModelConfigs() {
    const [configs, rate, levers] = await Promise.all([
      api.adminModelConfigs(),
      api.adminCreditRate(),
      api.adminBillingLevers(),
    ])
    setModelConfigs(configs)
    setCreditRate(rate)
    setBillingLevers(levers)
  }

  async function loadAdminData(nextQuery = query, announce = false) {
    setLoading(true)
    try {
      const [
        overviewData,
        modelConfigData,
        creditRateData,
        billingLeversData,
        agentRunData,
        userData,
        toolData,
        orderData,
        auditData,
      ] = await Promise.all([
        api.adminOverview(),
        api.adminModelConfigs(),
        api.adminCreditRate(),
        api.adminBillingLevers(),
        api.adminAgentRuns(),
        api.adminUsers(nextQuery, PAGE_SIZE, 0),
        api.adminToolCalls(PAGE_SIZE, 0),
        api.adminOrders(PAGE_SIZE, 0),
        api.adminAuditLogs(PAGE_SIZE, 0),
      ])
      setOverview(overviewData)
      setModelConfigs(modelConfigData)
      setCreditRate(creditRateData)
      setBillingLevers(billingLeversData)
      setAgentRuns(agentRunData)
      setUsers(userData)
      setPage(0)
      setHasMoreUsers(userData.length === PAGE_SIZE)
      setToolCalls(toolData)
      setToolPage(0)
      setHasMoreTool(toolData.length === PAGE_SIZE)
      setOrders(orderData)
      setOrderPage(0)
      setHasMoreOrders(orderData.length === PAGE_SIZE)
      setAuditLogs(auditData)
      setAuditPage(0)
      setHasMoreAudit(auditData.length === PAGE_SIZE)
      if (announce) {
        setNotice('数据已刷新')
      }
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : '加载后台数据失败')
    } finally {
      setLoading(false)
    }
  }

  async function changeToolCallsPage(nextPage: number) {
    if (nextPage < 0) {
      return
    }
    setNotice('')
    try {
      await loadToolCallsPage(nextPage)
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : '加载工具调用失败')
    }
  }

  async function changeOrdersPage(nextPage: number) {
    if (nextPage < 0) {
      return
    }
    setNotice('')
    try {
      await loadOrdersPage(nextPage)
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : '加载订单失败')
    }
  }

  async function changeAuditPage(nextPage: number) {
    if (nextPage < 0) {
      return
    }
    setNotice('')
    try {
      await loadAuditPage(nextPage)
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : '加载审计日志失败')
    }
  }

  async function searchUsers() {
    setNotice('')
    try {
      await loadUsersPage(query, 0)
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : '加载用户失败')
    }
  }

  async function changeUsersPage(nextPage: number) {
    if (nextPage < 0) {
      return
    }
    setNotice('')
    try {
      await loadUsersPage(query, nextPage)
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : '加载用户失败')
    }
  }

  async function refreshAdminData() {
    setNotice('')
    await loadAdminData(query, true)
  }

  async function openUser(userId: string) {
    setNotice('')
    try {
      setSelectedUser(await api.adminUserDetail(userId))
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : '加载用户详情失败')
    }
  }

  function closeUser() {
    setSelectedUser(null)
  }

  async function openAgentTrace(runId: string) {
    setNotice('')
    setTraceLoadingId(runId)
    try {
      setAgentTrace(await api.adminAgentRunTrace(runId))
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : '加载 Run Trace 失败')
    } finally {
      setTraceLoadingId('')
    }
  }

  async function updateStatus(status: 'active' | 'disabled') {
    if (!selectedUser) {
      return
    }
    if (!reason.trim()) {
      setNotice('请填写操作原因')
      return
    }
    try {
      await api.adminUpdateUserStatus(selectedUser.user.id, status, reason.trim())
      setReason('')
      setSelectedUser(await api.adminUserDetail(selectedUser.user.id))
      await loadAdminData()
      setNotice('用户状态已更新')
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : '用户状态更新失败')
    }
  }

  async function adjustCredits() {
    if (!selectedUser) {
      return
    }
    const parsedDelta = Number(delta)
    if (!Number.isFinite(parsedDelta) || parsedDelta === 0) {
      setNotice('额度调整不能为 0')
      return
    }
    if (!reason.trim()) {
      setNotice('请填写操作原因')
      return
    }
    try {
      await api.adminAdjustCredits(selectedUser.user.id, parsedDelta, reason.trim())
      setDelta('')
      setReason('')
      setSelectedUser(await api.adminUserDetail(selectedUser.user.id))
      await loadAdminData()
      setNotice('额外额度已调整')
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : '额度调整失败')
    }
  }

  function switchSection(value: string) {
    if (isAdminSection(value)) {
      setActiveSection(value)
      setNotice('')
    }
  }

  return {
    state: {
      overview,
      users,
      page,
      hasMoreUsers,
      toolCalls,
      toolPage,
      hasMoreTool,
      orders,
      orderPage,
      hasMoreOrders,
      modelConfigs,
      creditRate,
      billingLevers,
      agentRuns,
      auditLogs,
      auditPage,
      hasMoreAudit,
      selectedUser,
      agentTrace,
      traceLoadingId,
      query,
      delta,
      reason,
      notice,
      loading,
      activeSection,
      modelCreateRequest,
    },
    actions: {
      setQuery,
      setDelta,
      setReason,
      setNotice,
      setAgentTrace,
      requestModelCreate: () => setModelCreateRequest((value) => value + 1),
      reloadModelConfigs,
      refreshAdminData,
      changeToolCallsPage,
      changeOrdersPage,
      changeAuditPage,
      searchUsers,
      changeUsersPage,
      openUser,
      closeUser,
      openAgentTrace,
      updateStatus,
      adjustCredits,
      switchSection,
    },
  }
}
