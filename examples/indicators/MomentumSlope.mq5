//+------------------------------------------------------------------+
//|                                               MomentumSlope.mq5   |
//|                                       mql5-transpiler PoC sample  |
//|                                                                  |
//|  A tiny SOURCE custom indicator: the N-bar momentum SLOPE of the  |
//|  close — buffer[i] = close[i] - close[i-N]. Positive means price  |
//|  is higher than N bars ago (up-momentum); negative means lower    |
//|  (down-momentum); zero means flat over the window.                |
//|                                                                  |
//|  Drives the `iCustom` pipeline:                                  |
//|    handle = iCustom(_Symbol, _Period, "MomentumSlope", InpPeriod);|
//|    CopyBuffer(handle, 0, 0, n, dest);                            |
//|                                                                  |
//|  MT5-idiomatic warm-up: the first N bars have no value N-bars-ago,|
//|  so the indicator writes EMPTY_VALUE there (as a real MT5 custom  |
//|  indicator does via PLOT_EMPTY_VALUE). CopyBuffer then returns    |
//|  FEWER than requested when the window reaches into warm-up.       |
//+------------------------------------------------------------------+
#property copyright "mql5-transpiler PoC"
#property version   "1.00"
#property indicator_chart_window
#property indicator_buffers 1
#property indicator_plots   1

//--- inputs
input int InpPeriod = 10;   // momentum look-back (bars)

//--- the single output buffer (the slope series)
double ExtSlopeBuffer[];

//+------------------------------------------------------------------+
//| Custom indicator initialization                                  |
//+------------------------------------------------------------------+
int OnInit()
  {
   SetIndexBuffer(0, ExtSlopeBuffer, INDICATOR_DATA);
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
   int period = InpPeriod;
   if(period < 1)
      period = 1;

   for(int i = 0; i < rates_total; i++)
     {
      if(i < period)
        {
         ExtSlopeBuffer[i] = EMPTY_VALUE;   // warm-up: no bar N back yet
         continue;
        }
      // N-bar slope of the close: how far price has travelled over the window.
      ExtSlopeBuffer[i] = close[i] - close[i - period];
     }

   return(rates_total);
  }
//+------------------------------------------------------------------+
