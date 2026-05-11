function packageIds(m: Manifest): DeepbookPackageIds {
    return {
        DEEPBOOK_PACKAGE_ID: m.packages.deepbook.packageId,
        REGISTRY_ID: pickObject(m.packages.deepbook.objects, "Registry", "Margin"),
        DEEP_TREASURY_ID: pickObject(m.packages.token.objects, "ProtectedTreasury"),
    };
}
function coinMap(m: Manifest): CoinMap {
    return {
        DEEP: { address: m.packages.token.packageId, type: m.pools.DEEP_SUI.baseCoinType, scalar: 1_000_000 },
        SUI: { address: SUI_FRAMEWORK_ADDRESS, type: `${SUI_FRAMEWORK_ADDRESS}::sui::SUI`, scalar: 1_000_000_000 },
        USDC: { address: m.packages.usdc.packageId, type: m.pools.SUI_USDC.quoteCoinType, scalar: 1_000_000 },
    };
}
function poolMap(m: Manifest): PoolMap {
    return {
        DEEP_SUI: { address: m.pools.DEEP_SUI.poolId, baseCoin: "DEEP", quoteCoin: "SUI" },
        SUI_USDC: { address: m.pools.SUI_USDC.poolId, baseCoin: "SUI", quoteCoin: "USDC" },
    };
}
