async function withRetry<T>(
    fn: () => Promise<T>,
    retries = 3,
): Promise<T> {
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (attempt === retries - 1) throw err;
            await new Promise((res) => setTimeout(res, 50 * (attempt + 1)));
        }
    }
    throw new Error("unreachable");
}
