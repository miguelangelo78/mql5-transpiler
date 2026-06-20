//+------------------------------------------------------------------+
//|                                              HelloWorld.mq5       |
//|                                       mql5-transpiler PoC sample  |
//|                                                                  |
//|  The minimal starter EA — the clearest possible "it works".      |
//|   - OnInit  greets and prints the chart's symbol + period.       |
//|   - OnTick  prints the current bid exactly ONCE (a bool guard     |
//|             latches it), then stays quiet for the rest of the run.|
//|                                                                  |
//|  No trading, no indicators — just proof the transpile → backtest  |
//|  pipeline runs your code's OnInit/OnTick lifecycle end to end.    |
//+------------------------------------------------------------------+
#property copyright "mql5-transpiler PoC"
#property version   "1.00"
#property strict

//--- globals
bool printedFirstTick = false;   // latch: print the bid on the first tick only

//+------------------------------------------------------------------+
//| Expert initialization                                            |
//+------------------------------------------------------------------+
int OnInit()
  {
   Print("Hello, World!");
   Print("Running on symbol ", _Symbol, ", period ", _Period);
   return(INIT_SUCCEEDED);
  }
//+------------------------------------------------------------------+
//| Expert deinitialization                                          |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   Print("Goodbye — HelloWorld finished.");
  }
//+------------------------------------------------------------------+
//| Expert tick                                                      |
//+------------------------------------------------------------------+
void OnTick()
  {
   if(printedFirstTick)
      return;   // already greeted on the first tick — stay quiet

   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   Print("First tick — current bid is ", DoubleToString(bid, _Digits));
   printedFirstTick = true;
  }
//+------------------------------------------------------------------+
