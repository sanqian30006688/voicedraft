import InspirationTabs from "@/components/InspirationTabs";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <InspirationTabs />
      {children}
    </>
  );
}
