import { ContentLoading } from "@/components/doc/content-loading";
import styles from "@/components/doc/doc.module.css";

export default function Loading() {
  return <main className={styles.main} aria-busy="true"><ContentLoading /></main>;
}
