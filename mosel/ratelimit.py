"""In-memory rate limits: per client per minute and per day, plus a server-wide daily cap.

Good enough for one process on a small host. Several workers would need a shared store.
"""
from __future__ import annotations

import time
from collections import defaultdict, deque


class RateLimiter:
    def __init__(self, per_minute: int, per_day: int, daily_cap: int, clock=time.time):
        self.per_minute = per_minute
        self.per_day = per_day
        self.daily_cap = daily_cap
        self.clock = clock
        self._recent: dict[str, deque] = defaultdict(deque)
        self._day = ""
        self._per_client_day: dict[str, int] = defaultdict(int)
        self._total_day = 0

    def check(self, client: str) -> str | None:
        """Record a request; return None if allowed, else a reason."""
        now = self.clock()
        day = time.strftime("%Y-%m-%d", time.gmtime(now))
        if day != self._day:
            self._day, self._per_client_day, self._total_day = day, defaultdict(int), 0
        recent = self._recent[client]
        while recent and now - recent[0] >= 60:
            recent.popleft()
        if len(recent) >= self.per_minute:
            return f"too many requests: at most {self.per_minute} per minute"
        if self._per_client_day[client] >= self.per_day:
            return f"daily limit reached: {self.per_day} AI requests per day"
        if self._total_day >= self.daily_cap:
            return "the server's daily AI budget is used up; try again tomorrow or use your own Groq key"
        recent.append(now)
        self._per_client_day[client] += 1
        self._total_day += 1
        return None
