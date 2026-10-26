import styles from "./content-loading.module.css";

/** Rendered on the server too, before the document's client code is ready. */
export function ContentLoading() {
  return <div className={styles.loading} role="status" aria-label="Loading content…">
    <p><span className={styles.spinner} aria-hidden="true" />Loading content…</p>
    <div className={styles.lines} aria-hidden="true"><span /><span /><span /></div>
  </div>;
}
