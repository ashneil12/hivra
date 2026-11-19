import { notFound } from "next/navigation";
import { ComputerExport } from "@/components/hivra/ComputerExport";

export default function ComputerExportPage() {
  if (process.env.NEXT_PUBLIC_HIVRA_COMPUTER_EXPORT !== "true") notFound();
  return <ComputerExport />;
}
