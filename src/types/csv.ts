export interface MeisaiRow {
  事業者名: string;
  処理月: string;
  職員番号: string;
  職員名: string;
  開始日: string;
  終了日: string;
  日付: string;
  派遣開始時間: string;
  派遣終了時間: string;
  利用者名: string;
  サービス: string;
  実時刻開始時間: string;
  実時刻終了時間: string;
  実時間: string;
  算定開始時刻: string;
  算定終了時刻: string;
  算定時間: string;
  休日区分: string;
  時間帯: string;
  サービス型: string;
  金額: string;
  交通費: string;
  電話代?: string;
  調整費?: string;
  会議費?: string;
  研修?: string;
  その他手当?: string;
  合計?: string;
  同行訪問?: string;
  事業所番号: string;
  利用者番号: string;
  サービスコード: string;
}

export interface AttendanceRow {
  日付: string;
  曜日: string;
  振替日: string;
  勤務摘要: string;
  勤務摘要2: string;
  勤務摘要3: string;
  勤務摘要4: string;
  勤務摘要5: string;
  開始: string;
  終了: string;
  開始2: string;
  終了2: string;
  開始3: string;
  終了3: string;
  開始4: string;
  終了4: string;
  開始5: string;
  終了5: string;
  休憩: string;
  勤務時間: string;
  通勤km?: string;
  出張km?: string;
  週残業?: string;
  日残業?: string;
  休日?: string;
  法内残業?: string;
  控除?: string;
  備考?: string;
}

export interface AttendanceMeta {
  year: number;
  month: number;
  employeeNumber: string;
  employeeName: string;
  officeName: string;
  officeNumber: string;
}

export interface ParsedAttendance {
  meta: AttendanceMeta;
  rows: AttendanceRow[];
  totals: {
    breakTime: string;
    workHours: string;
    commuteKm: number;
    businessKm: number;
    overtimeHours: string;
  };
}

export interface CsvParseResult<T> {
  success: boolean;
  data: T[];
  errors: string[];
  fileName: string;
}
