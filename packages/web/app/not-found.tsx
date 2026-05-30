import Link from "next/link";
import { t } from "../lib/i18n/t";

export default function NotFound() {
  return (
    <main className="max-w-3xl mx-auto px-4 py-10 space-y-3 text-center">
      <h1 className="text-zinc-200">{t("errors.notFound")}</h1>
      <Link href="/" className="text-sm text-cyan-400 hover:underline">{t("detail.back")}</Link>
    </main>
  );
}
