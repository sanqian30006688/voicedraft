import { Suspense } from "react";
import InspirationPage from "@/components/InspirationPage";

export default function Page() {
  return (
    <Suspense>
      <InspirationPage />
    </Suspense>
  );
}
