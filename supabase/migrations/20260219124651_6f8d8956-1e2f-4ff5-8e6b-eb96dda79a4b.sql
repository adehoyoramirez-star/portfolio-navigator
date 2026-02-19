
-- Create portfolio table for storing positions and reserve
CREATE TABLE public.portfolio (
  id TEXT NOT NULL DEFAULT 'default' PRIMARY KEY,
  cash_reserve FLOAT NOT NULL DEFAULT 2000,
  positions JSONB NOT NULL DEFAULT '{}',
  monthly_contribution FLOAT NOT NULL DEFAULT 400,
  btc_min_weight FLOAT NOT NULL DEFAULT 0.25,
  btc_max_weight FLOAT NOT NULL DEFAULT 0.35,
  last_updated TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.portfolio ENABLE ROW LEVEL SECURITY;

-- Allow public read/write for now (single-user app, no auth needed)
CREATE POLICY "Allow public read" ON public.portfolio FOR SELECT USING (true);
CREATE POLICY "Allow public insert" ON public.portfolio FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public update" ON public.portfolio FOR UPDATE USING (true);

-- Insert default record
INSERT INTO public.portfolio (id, cash_reserve, positions)
VALUES ('default', 2000, '{
  "BTC-EUR": {"shares": 0.05, "avgPrice": 60000},
  "EMXC.DE": {"shares": 50, "avgPrice": 28},
  "IS3Q.DE": {"shares": 100, "avgPrice": 6.5},
  "PPFB.DE": {"shares": 30, "avgPrice": 200},
  "URNU.DE": {"shares": 15, "avgPrice": 8.5},
  "VVSM.DE": {"shares": 20, "avgPrice": 30},
  "ZPRR.DE": {"shares": 40, "avgPrice": 15}
}');
