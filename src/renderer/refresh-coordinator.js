export function createLatestRequestCoordinator() {
  let latestRequestId = 0;

  return async function runLatest(load, commit) {
    const requestId = ++latestRequestId;
    const result = await load();
    if (requestId === latestRequestId) {
      await commit(result);
    }
    return result;
  };
}
