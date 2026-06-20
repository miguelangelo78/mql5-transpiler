//+------------------------------------------------------------------+
//|                                                     SimpleMA.mq5  |
//|                                       mql5-transpiler PoC sample  |
//|                                                                  |
//|  A minimal SOURCE custom indicator: a Simple Moving Average of   |
//|  the close, written into one output buffer (buffer 0).           |
//|                                                                  |
//|  Drives the `iCustom` pipeline:                                  |
//|    handle = iCustom(_Symbol, _Period, "SimpleMA", InpMAPeriod);  |
//|    CopyBuffer(handle, 0, 0, n, dest);                            |
//|                                                                  |
//|  MT5-idiomatic warm-up handling: the first (period-1) bars have  |
//|  NO moving-average value, so the indicator writes EMPTY_VALUE    |
//|  there (exactly as a real MT5 SMA does via PLOT_EMPTY_VALUE).    |
//|  CopyBuffer then returns FEWER than requested when the window    |
//|  reaches into warm-up — matching the native iMA(MODE_SMA).       |
//+------------------------------------------------------------------+
#property copyright "mql5-transpiler PoC"
#property version   "1.00"
#property indicator_chart_window
#property indicator_buffers 1
#property indicator_plots   1

//--- inputs
input int InpMAPeriod = 10;   // Averaging period

//--- the single output buffer
double ExtMABuffer[];

//+------------------------------------------------------------------+
//| Custom indicator initialization                                  |
//+------------------------------------------------------------------+
int OnInit()
  {
   SetIndexBuffer(0, ExtMABuffer, INDICATOR_DATA);
   return(INIT_SUCCEEDED);
  }
//+------------------------------------------------------------------+
//| Custom indicator iteration                                       |
//+------------------------------------------------------------------+
int OnCalculate(const int rates_total,
                const int prev_calculated,
                const datetime &time[],
                const double &open[],
                const double &high[],
                const double &low[],
                const double &close[],
                const long &tick_volume[],
                const long &volume[],
                const int &spread[])
  {
   int period = InpMAPeriod;
   if(period < 1)
      period = 1;

   for(int i = 0; i < rates_total; i++)
     {
      if(i < period - 1)
        {
         ExtMABuffer[i] = EMPTY_VALUE;   // warm-up: no MA value yet
         continue;
        }
      double sum = 0.0;
      for(int k = 0; k < period; k++)
         sum += close[i - k];
      ExtMABuffer[i] = sum / period;
     }

   return(rates_total);
  }
//+------------------------------------------------------------------+
