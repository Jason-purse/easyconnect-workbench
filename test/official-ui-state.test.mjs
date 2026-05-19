import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOfficialUiState,
  describeOfficialUiConsistency,
  formatOfficialUiMetric,
} from "../src/services/official-ui-state.js";

test("buildOfficialUiState classifies a visible failed connect page", () => {
  const state = buildOfficialUiState({
    reachable: true,
    targets: [
      {
        id: "connect",
        type: "page",
        title: "EasyConnect",
        url: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect/connect.html",
        visibilityState: "visible",
        hidden: false,
        bodyText: "无法连接 请检查网络后重试 继续",
      },
      {
        id: "service",
        type: "page",
        title: "EasyConnect",
        url: "https://198.51.100.20:9898/portal/#!/service",
        visibilityState: "hidden",
        hidden: true,
        bodyText: "资源搜索 默认资源组",
      },
    ],
  });

  assert.equal(state.primaryTarget.kind, "probe-failed");
  assert.equal(state.hasServiceTarget, true);
  assert.equal(state.hasBlockingVisibleTarget, true);
  assert.equal(formatOfficialUiMetric(state), "探测失败");
});

test("describeOfficialUiConsistency warns when tunnel is online but official UI is blocked", () => {
  const state = buildOfficialUiState({
    reachable: true,
    targets: [
      {
        id: "connect",
        type: "page",
        title: "EasyConnect",
        url: "file:///Applications/EasyConnect.app/Contents/Resources/Web/local/connect/connect.html",
        visibilityState: "visible",
        hidden: false,
        bodyText: "无法连接",
      },
    ],
  });

  assert.deepEqual(
    describeOfficialUiConsistency({
      loginStatus: { status: "1" },
      officialUi: state,
    }),
    {
      title: "隧道在线，官方窗口异常",
      detail: "底层 VPN 已在线，但 EasyConnect 前台仍停在探测失败页；刷新状态不能再等同于官方 UI 正常。",
      variant: "warn",
    },
  );
});

test("describeOfficialUiConsistency returns null when service page is the primary official UI", () => {
  const state = buildOfficialUiState({
    reachable: true,
    targets: [
      {
        id: "service",
        type: "page",
        title: "EasyConnect",
        url: "https://198.51.100.20:9898/portal/#!/service",
        visibilityState: "visible",
        hidden: false,
        bodyText: "资源搜索 默认资源组",
      },
    ],
  });

  assert.equal(
    describeOfficialUiConsistency({
      loginStatus: { status: "1" },
      officialUi: state,
    }),
    null,
  );
  assert.equal(formatOfficialUiMetric(state), "服务页");
});

test("user setting page text does not count as a blocking login form", () => {
  const state = buildOfficialUiState({
    reachable: true,
    targets: [
      {
        id: "user-setting",
        type: "page",
        title: "个人设置",
        url: "https://198.51.100.20:9898/portal/#!/user_setting_box",
        visibilityState: "visible",
        hidden: false,
        bodyText: "个人设置 修改密码 登录设备",
      },
      {
        id: "service",
        type: "page",
        title: "EasyConnect",
        url: "https://198.51.100.20:9898/portal/#!/service",
        visibilityState: "hidden",
        hidden: true,
        bodyText: "资源搜索 默认资源组",
      },
    ],
  });

  const userSetting = state.targets.find((target) => target.kind === "user-setting");

  assert.equal(userSetting.signals.loginForm, false);
  assert.equal(state.primaryTarget.kind, "user-setting");
  assert.equal(state.hasServiceTarget, true);
  assert.equal(state.hasBlockingVisibleTarget, false);
  assert.equal(
    describeOfficialUiConsistency({
      loginStatus: { status: "1" },
      officialUi: state,
    }),
    null,
  );
});

test("buildOfficialUiState treats a visible failed service page as blocked", () => {
  const state = buildOfficialUiState({
    reachable: true,
    targets: [
      {
        id: "service",
        type: "page",
        title: "EasyConnect",
        url: "https://198.51.100.20:9898/portal/#!/service",
        visibilityState: "visible",
        hidden: false,
        bodyText: "加载失败 请尝试刷新后重试",
      },
    ],
  });

  assert.equal(state.primaryTarget.kind, "service-failed");
  assert.equal(state.hasServiceTarget, false);
  assert.equal(state.hasBlockingVisibleTarget, true);
  assert.equal(formatOfficialUiMetric(state), "服务页异常");
  assert.deepEqual(
    describeOfficialUiConsistency({
      loginStatus: { status: "1" },
      officialUi: state,
    }),
    {
      title: "隧道在线，官方服务页加载失败",
      detail: "底层 VPN 可能已在线，但 EasyConnect 服务页资源配置加载失败；需要重新同步并刷新服务页。",
      variant: "warn",
    },
  );
});
