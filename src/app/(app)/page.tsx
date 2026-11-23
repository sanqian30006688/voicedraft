import Workbench from "@/components/Workbench";

export default async function Home({ searchParams }: { searchParams: Promise<{ topic?: string | string[] }> }) {
  const { topic } = await searchParams;
  const initialTopic = typeof topic === "string" ? topic.slice(0, 500) : undefined;
  return <Workbench initialTopic={initialTopic} />;
}
