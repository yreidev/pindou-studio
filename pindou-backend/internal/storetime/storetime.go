// Package storetime 是门店时区：按日期、年份判断的业务口径（今天的入座申请、生日年度、营业时段、
// 导出的日期范围）一律用它，不用服务器或设备的时区。门店在中国，没有夏令时，固定东八区。
package storetime

import "time"

// Location 是门店所在的时区（中国标准时间）。
var Location = time.FixedZone("CST", 8*60*60)
