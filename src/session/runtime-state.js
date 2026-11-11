// Background tick sessions, the active view and the network module loader.
import { LogUtil, UiController, UiRegistry } from '../main.js';

/* =========================
   Background simulation ticker
   ========================= */
const BACKGROUND_TICK_SESSIONS = new Set();

/* Mutable state ownership: each cohesive runtime/presentation concern owns its state. */

/* ActiveViewState owns only the currently displayed view bindings.
   Authoritative battle state remains in GameSession/StrategySim; this class must never
   duplicate simulation state or become a shadow runtime registry. */
class ActiveViewState {
    static role = null;
    static roomCode = null;
    static transport = null;
    static session = null;
    static renderer = null;
    static minimap = null;
    static snap = null;
    static drag = null;
}

class NetworkModuleLoader {
    static async ensureReady() {
        NetworkModuleLoader.networkLoaderStarted = true;
        if (typeof globalThis.RallyNetcode?.createNostrSignaler === 'function') {
            NetworkModuleLoader.networkLoadState = 'ready';
            NetworkModuleLoader.networkLoadError = '';
            LogUtil.status('온라인 네트워크 준비됨');
            const action = NetworkModuleLoader.pendingPeerAction;
            NetworkModuleLoader.pendingPeerAction = null;
            if (action) action();
            return true;
        }
        NetworkModuleLoader.networkLoadState = 'error';
        NetworkModuleLoader.networkLoadError = 'URL 네트워크 모듈이 준비되지 않았습니다.';
        LogUtil.status('온라인 네트워크 모듈 준비 실패');
        if (UiRegistry.refs.createDialog.open) {
            UiRegistry.refs.createStatus.textContent =
                NetworkModuleLoader.networkLoadError + ' 최신 HTML을 다시 열어 주세요.';
            UiController.setElementVisible(UiRegistry.refs.createRetry, true);
        }
        if (UiRegistry.refs.joinDialog.open)
            UiRegistry.refs.joinError.textContent =
                NetworkModuleLoader.networkLoadError + ' 최신 HTML을 다시 열어 주세요.';
        return false;
    }

    static networkLoadState = 'loading';
    static networkLoadError = '';
    static pendingPeerAction = null;
    static networkLoaderStarted = false;
}

export { ActiveViewState, BACKGROUND_TICK_SESSIONS, NetworkModuleLoader };
