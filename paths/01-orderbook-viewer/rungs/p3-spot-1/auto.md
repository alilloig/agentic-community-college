useEffect(() => {
    if (!client) return;
    let failures = 0;

    const tick = async () => {
        try {
            const mid = await withRetry(() =>
                client.deepbook.midPrice(POOL_ID),
            );
            const ticks = await withRetry(() =>
                client.deepbook.getLevel2TicksFromMid(POOL_ID, DEPTH),
            );
            setMidPrice(mid);
            setLevel2Ticks(ticks);
            failures = 0;
        } catch (err) {
            failures += 1;
            console.warn(`Polling tick failed (${failures} consecutive):`, err);
        }
    };

    void tick();
    const id = setInterval(() => { void tick(); }, {{ poll_interval_ms }});
    return () => clearInterval(id);
}, [client]);
