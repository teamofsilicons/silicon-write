import { Library } from "@/components/library/library";

export const metadata = { title: "Folder" };

export default async function Page({ params }: { params: Promise<{ folder: string }> }) {
  const { folder } = await params;
  return <Library view="mine" folderId={folder} />;
}
