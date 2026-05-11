# Orderbook Viewer

In this path you will build a real-time orderbook viewer for DeepBook v3 — the central limit order book (CLOB) protocol on Sui.

## What you will build

A TypeScript application that:
- Connects to the Sui network and the DeepBook v3 indexer
- Subscribes to orderbook updates for one or more liquidity pools
- Renders bids, asks, and spread in a readable format

## Prerequisites

- Familiarity with TypeScript and async/await
- Basic understanding of order books (bids, asks, spread)
- `sui` CLI installed and configured for devnet or testnet
- `pnpm` installed

## What you will learn

- How to use the Sui TypeScript SDK to query on-chain state
- How to work with the DeepBook v3 pool objects and indexer API
- How to structure a real-time polling loop with configurable intervals
- How to filter pools by asset pair using the `pool_subset` personalization option

## Duration

Approximately 90 minutes across three phases: setup, core logic, and display polish.
