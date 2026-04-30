// Path-based alias for the Dashboard component. Each dashboard tab now
// has its own URL (`/app/settings`) so the Shopify admin sidebar can
// highlight the active sub-nav item correctly — NavMenu matches by
// pathname and previously every tab shared `/app`.
//
// The actual Dashboard component reads the active tab from the URL
// pathname; this file just re-exports default + loader from the index.
export { default, loader } from "./app._index";
