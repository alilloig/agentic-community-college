/**
 * Order Book Viewer — a purely-read-only DeepBook Sandbox smoke test.
 *
 * 1. Fetch the deployment manifest from the sandbox faucet (which mirrors
 *    sandbox/deployments/localnet.json).
 * 2. Build a DeepBook SDK client against the localnet RPC.
 * 3. Poll midPrice + getLevel2TicksFromMid every 3s and render.
 */
import { useEffect, useMemo, useState } from "react";
import { deepbook, type CoinMap, type PoolMap, type DeepbookPackageIds } from "@mysten/deepbook-v3";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { SUI_FRAMEWORK_ADDRESS } from "@mysten/sui/utils";

// ---------- Manifest types (shape from sandbox/scripts/deploy-all.ts) ---------

interface Manifest {
    packages: Record<string, { packageId: string; objects: Array<{ objectId: string; objectType: string }> }>;
    pools: Record<string, { poolId: string; baseCoinType: string; quoteCoinType: string }>;
    deployerAddress: string;
}

const ZERO_ADDR = "0x0000000000000000000000000000000000000000000000000000000000000000";

// Read-only helpers (mirror examples/sandbox/setup.ts but inlined) ------------

/**
 * Match an object whose type ends with `::TypeName` or `::TypeName<…>`.
 * Naive .includes() is dangerous: "Registry" matches RegistryInner and
 * dynamic_field::Field<u64, RegistryInner> child objects, which are owned
 * by the Versioned wrapper and fail as PTB inputs.
 */
function pickObject(objs: Manifest["packages"][string]["objects"], typeName: string, exclude?: string) {
    const pattern = new RegExp(`::${typeName}(?:<|$)`);
    const o = objs.find((x) => pattern.test(x.objectType) && (!exclude || !x.objectType.includes(exclude)));
    if (!o) throw new Error(`Deployment manifest missing object matching ::${typeName}`);
    return o.objectId;
}

function packageIds(m: Manifest): DeepbookPackageIds {
    // TODO p1-spot-1: extract DEEPBOOK_PACKAGE_ID from m.packages.deepbook.packageId,
    // REGISTRY_ID via pickObject(m.packages.deepbook.objects, "Registry", "Margin"),
    // and DEEP_TREASURY_ID via pickObject(m.packages.token.objects, "ProtectedTreasury").
}
function coinMap(m: Manifest): CoinMap {
    // TODO p1-spot-1: build the {DEEP, SUI, USDC} CoinMap. DEEP scalar is 1_000_000;
    // SUI scalar is 1_000_000_000 and address SUI_FRAMEWORK_ADDRESS; USDC scalar is 1_000_000.
}
function poolMap(m: Manifest): PoolMap {
    // TODO p1-spot-1: map DEEP_SUI and SUI_USDC to their poolId from m.pools, with
    // the appropriate baseCoin / quoteCoin labels.
}

// ---------- App ---------------------------------------------------------------

type Book = { midPrice: number; asks: Array<{ price: number; qty: number }>; bids: Array<{ price: number; qty: number }> };

export function App() {
    const [pool, setPool] = useState<"DEEP_SUI" | "SUI_USDC">("DEEP_SUI");
    const [manifest, setManifest] = useState<Manifest | null>(null);
    const [err, setErr] = useState<string | null>(null);
    const [book, setBook] = useState<Book | null>(null);

    // 1. Fetch manifest once.
    useEffect(() => {
        (async () => {
            try {
                // Prefer the vite proxy (works around CORS on localhost:9009).
                const r = await fetch("/api/faucet/manifest");
                if (!r.ok) throw new Error(`faucet /manifest returned ${r.status}`);
                setManifest(await r.json());
            } catch (e: unknown) {
                setErr(`Is the sandbox running? (\`pnpm deploy-all\`) — ${(e as Error).message}`);
            }
        })();
    }, []);

    // 2. Build SDK client once manifest is available.
    const client = useMemo(() => {
        if (!manifest) return null;
        return new SuiGrpcClient({ network: "custom", baseUrl: "http://localhost:9000" }).$extend(
            deepbook({ address: ZERO_ADDR, packageIds: packageIds(manifest), coins: coinMap(manifest), pools: poolMap(manifest) }),
        );
    }, [manifest]);

    // 3. Poll order book every 3 seconds.
    useEffect(() => {
        if (!client) return;
        let cancelled = false;
        let failures = 0;

        async function withRetry<T>(_fn: () => Promise<T>, _retries = 2): Promise<T> {
            // TODO p2-spot-1: implement an exponential-backoff retry helper.
            // Loop up to `retries` times, calling fn(); on error, sleep ~300ms and retry;
            // on the final attempt, rethrow. Returns fn()'s resolved value on success.
            throw new Error("TODO p2-spot-1: implement withRetry");
        }

        async function tick() {
            try {
                // TODO p3-spot-1: poll midPrice and getLevel2TicksFromMid via withRetry,
                // update the React `book` state with the parsed order book, and reset
                // `failures` on success. Catch errors, increment `failures`, and only
                // surface them after 3 consecutive misses.
                throw new Error("TODO p3-spot-1: implement polling tick");
            } catch (e: unknown) {
                if (cancelled) return;
                failures++;
                if (failures >= 3) setErr((e as Error).message);
            }
        }
        tick();
        const id = setInterval(tick, 3000);
        return () => {
            cancelled = true;
            clearInterval(id);
        };
    }, [client, pool]);

    const maxQty = book ? Math.max(1, ...book.asks.map((x) => x.qty), ...book.bids.map((x) => x.qty)) : 1;
    const bar = (qty: number, color: string) => ({
        width: `${(qty / maxQty) * 100}%`,
        background: color,
        height: 16,
        borderRadius: 2,
    });

    return (
        <div style={{ maxWidth: 720, margin: "2rem auto", padding: "0 1rem" }}>
            <h1 style={{ fontSize: 20, margin: 0 }}>DeepBook Order Book</h1>
            <p style={{ color: "#8b94a7", marginTop: 4 }}>
                Read-only viewer. Sandbox localnet ·{" "}
                <span style={{ color: manifest ? "#6dd56d" : err ? "#e08585" : "#cccc80" }}>
                    {manifest ? "connected" : err ? "error" : "connecting…"}
                </span>
            </p>

            <div style={{ margin: "1rem 0" }}>
                {(["DEEP_SUI", "SUI_USDC"] as const).map((p) => (
                    <button
                        key={p}
                        onClick={() => setPool(p)}
                        style={{
                            marginRight: 8,
                            padding: "6px 12px",
                            background: p === pool ? "#2a3242" : "transparent",
                            color: "#d5d9e0",
                            border: "1px solid #333b4c",
                            borderRadius: 4,
                            cursor: "pointer",
                        }}
                    >
                        {p.replace("_", "/")}
                    </button>
                ))}
            </div>

            {err && <pre style={{ color: "#e08585", fontSize: 13 }}>{err}</pre>}
            {book === null ? (
                <p style={{ color: "#8b94a7" }}>Loading order book…</p>
            ) : (
                <>
                    <p style={{ color: "#a9b3c5" }}>
                        Mid: <b style={{ color: "#f5f7fa" }}>{book.midPrice.toFixed(8).replace(/0+$/, "").replace(/\.$/, "")}</b>
                    </p>

                    <section style={{ marginTop: 12 }}>
                        <div style={{ color: "#e08585", fontWeight: 600, marginBottom: 4 }}>Asks</div>
                        {[...book.asks].reverse().map((lvl, i) => (
                            <div key={i} style={{ display: "grid", gridTemplateColumns: "120px 1fr 80px", gap: 8, padding: "2px 0" }}>
                                <span style={{ fontFamily: "ui-monospace, monospace", color: "#e08585" }}>{lvl.price.toFixed(8)}</span>
                                <div style={bar(lvl.qty, "#e08585")} />
                                <span style={{ fontFamily: "ui-monospace, monospace", color: "#a9b3c5" }}>{lvl.qty.toFixed(2)}</span>
                            </div>
                        ))}
                    </section>

                    <section style={{ marginTop: 16 }}>
                        <div style={{ color: "#6dd56d", fontWeight: 600, marginBottom: 4 }}>Bids</div>
                        {book.bids.map((lvl, i) => (
                            <div key={i} style={{ display: "grid", gridTemplateColumns: "120px 1fr 80px", gap: 8, padding: "2px 0" }}>
                                <span style={{ fontFamily: "ui-monospace, monospace", color: "#6dd56d" }}>{lvl.price.toFixed(8)}</span>
                                <div style={bar(lvl.qty, "#6dd56d")} />
                                <span style={{ fontFamily: "ui-monospace, monospace", color: "#a9b3c5" }}>{lvl.qty.toFixed(2)}</span>
                            </div>
                        ))}
                    </section>
                </>
            )}
        </div>
    );
}
