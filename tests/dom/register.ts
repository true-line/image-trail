import { GlobalRegistrator } from '@happy-dom/global-registrator';

// happy-dom >= 21 treats CSS file loading as disabled by default and dispatches `error`
// synchronously when a stylesheet link connects. That trips PanelMount's fail-open reveal
// inside mount(), so a test can never observe the pre-reveal hidden state. Loading the
// harness's data: URLs locally keeps the event asynchronous, as in a browser, leaving the
// reveal under the test's control.
GlobalRegistrator.register({ settings: { enableCSSFileLoading: true } });
