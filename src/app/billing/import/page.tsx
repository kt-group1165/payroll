import { BillingImporter } from "@/components/csv/billing-importer";

export default function BillingImportPage() {
  return (
    <div>
      <h2 className="text-2xl font-bold mb-4">請求CSV取り込み</h2>
      <BillingImporter />
    </div>
  );
}
