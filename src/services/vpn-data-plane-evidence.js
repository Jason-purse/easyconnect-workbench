const MIN_ONLINE_EVIDENCE_FRESHNESS_MS = 60 * 1000;

export function getMaintainerEventResult(status = {}) {
  const result = status?.lastEvent?.result ?? {};
  return result.online
    ? {
        ...result.online,
        action: result.action ?? result.online.action,
        dataPlane: result.dataPlane ?? result.online.dataPlane,
        dataPlaneProbeRevision:
          result.dataPlaneProbeRevision ?? result.online.dataPlaneProbeRevision,
      }
    : result;
}

function isEvidenceFresh(status = {}, observedAt = null, nowMs = Date.now()) {
  if (!status.running) {
    return false;
  }

  if (!observedAt) {
    return true;
  }

  const eventAt = Date.parse(observedAt);
  if (!Number.isFinite(eventAt)) {
    return false;
  }

  const intervalSeconds = Number.parseInt(`${status.intervalSeconds ?? 300}`, 10) || 300;
  const freshnessMs = Math.max(MIN_ONLINE_EVIDENCE_FRESHNESS_MS, intervalSeconds * 2 * 1000);
  return nowMs - eventAt <= freshnessMs;
}

export function getMaintainerDataPlaneEvidence(status = {}, options = {}) {
  const eventResult = getMaintainerEventResult(status);
  const eventDataPlane = eventResult?.dataPlane ?? status?.lastEvent?.dataPlane ?? null;
  const eventCandidate = eventDataPlane
    ? {
        source: "maintainer",
        observedAt: eventDataPlane.observedAt ?? status.lastEventAt ?? null,
        dataPlane: eventDataPlane,
        activeSession: eventResult?.activeSession ?? null,
        loginStatus: eventResult?.loginStatus ?? null,
        dataPlaneProbeRevision:
          eventResult?.dataPlaneProbeRevision ?? status?.lastEvent?.dataPlaneProbeRevision ?? null,
      }
    : null;
  const observation = status?.dataPlaneObservation?.dataPlane
    ? {
        source: "observation",
        ...status.dataPlaneObservation,
      }
    : null;
  const eventTime = Date.parse(eventCandidate?.observedAt ?? "");
  const observationTime = Date.parse(observation?.observedAt ?? "");
  const evidence = observation && (
    !eventCandidate ||
    (Number.isFinite(observationTime) ? observationTime : Number.POSITIVE_INFINITY) >=
      (Number.isFinite(eventTime) ? eventTime : Number.NEGATIVE_INFINITY)
  )
    ? observation
    : eventCandidate;
  const dataPlane = evidence?.dataPlane ?? null;
  const expectedProbe = status?.dataPlaneProbe ?? null;
  const eventRevision = evidence?.dataPlaneProbeRevision ?? null;
  const currentRevision = status?.dataPlaneProbeRevision ?? null;
  const revisionMatches =
    currentRevision === null || eventRevision === null || currentRevision === eventRevision;
  const targetMatches = !expectedProbe || !dataPlane
    ? true
    : Boolean(expectedProbe.configured) === Boolean(dataPlane.configured) &&
      (expectedProbe.configured !== true || expectedProbe.target === dataPlane.target);
  const evidenceFresh = isEvidenceFresh(
    status,
    evidence?.observedAt ?? null,
    options.nowMs ?? Date.now(),
  );

  return {
    dataPlane,
    activeSession: evidence?.activeSession ?? null,
    loginStatus: evidence?.loginStatus ?? null,
    source: evidence?.source ?? null,
    evidenceFresh,
    evidenceMatchesProbe: Boolean(revisionMatches && targetMatches),
  };
}

export function resolveDataPlaneEvidence(snapshotStatus = {}, maintainerStatus = {}, options = {}) {
  if (options.dataPlane !== undefined) {
    return options.dataPlane;
  }
  if (Object.hasOwn(snapshotStatus, "dataPlane")) {
    return snapshotStatus.dataPlane;
  }

  const evidence = getMaintainerDataPlaneEvidence(maintainerStatus, options);
  if (evidence.dataPlane && evidence.evidenceFresh && evidence.evidenceMatchesProbe) {
    return evidence.dataPlane;
  }

  return maintainerStatus?.dataPlaneProbe ?? {
    configured: false,
    ok: null,
    state: "unconfigured",
    target: null,
  };
}
