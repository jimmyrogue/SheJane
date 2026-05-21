"""Custom middleware for the 6 phases that aren't covered by built-ins:

  P1 input_guard       — InputGuardMiddleware
  P2 routing (fast/deep) — FastDeepRouterMiddleware
  P4 reflection        — ReflectMiddleware
  P6 memory writeback  — MemoryWritebackMiddleware
  P7 skills            — SkillInjectionMiddleware
  P9 output guard      — OutputGuardMiddleware

Each is intentionally thin — the heavy lifting (planning, permission, retry,
step limits, context compaction) lives in the built-in middleware stack.
"""

from .input_guard import InputGuardMiddleware
from .memory_writeback import MemoryWritebackMiddleware
from .output_guard import OutputGuardMiddleware
from .reflect import ReflectMiddleware
from .router import FastDeepRouterMiddleware
from .skills import SkillInjectionMiddleware

__all__ = [
    "FastDeepRouterMiddleware",
    "InputGuardMiddleware",
    "MemoryWritebackMiddleware",
    "OutputGuardMiddleware",
    "ReflectMiddleware",
    "SkillInjectionMiddleware",
]
