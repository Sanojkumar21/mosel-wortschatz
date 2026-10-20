from mosel.ratelimit import RateLimiter


def test_minute_window_slides():
    now = [1000.0]
    rl = RateLimiter(per_minute=2, per_day=100, daily_cap=100, clock=lambda: now[0])
    assert rl.check("a") is None and rl.check("a") is None
    assert "per minute" in rl.check("a")
    assert rl.check("b") is None            # other clients are unaffected
    now[0] += 61
    assert rl.check("a") is None


def test_daily_limits():
    now = [1000.0]
    rl = RateLimiter(per_minute=100, per_day=2, daily_cap=3, clock=lambda: now[0])
    assert rl.check("a") is None and rl.check("a") is None
    assert "daily limit" in rl.check("a")
    assert rl.check("b") is None
    assert "budget" in rl.check("c")
    now[0] += 86_400
    assert rl.check("a") is None
