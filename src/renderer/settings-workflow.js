export async function persistSettingsAndRefresh({ save, afterSave, refresh } = {}) {
  const saved = await save();
  await afterSave?.(saved);

  try {
    await refresh?.();
    return { saved, refreshError: null };
  } catch (refreshError) {
    return { saved, refreshError };
  }
}
